# ---------------- ALB (only reachable from CloudFront) ----------------
# Two locks: the SG admits only CloudFront's origin-facing IPs, and the listener
# forwards only requests that carry CloudFront's secret header (anyone else's
# CloudFront distribution would pass the first lock, not the second).
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

# Accepted: public by design (CloudFront's origin); HTTP between CloudFront and the
# ALB, because an ALB HTTPS listener needs an ACM cert for a domain we own.
#trivy:ignore:AWS-0053
resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "gateway" {
  name                 = "${local.name}-gw"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip" # Fargate (awsvpc)
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

#trivy:ignore:AWS-0054
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_secret.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# ---------------- S3: product images ----------------
resource "aws_s3_bucket" "products" {
  bucket        = "shopflow-products-${local.account_id}-stage2"
  force_destroy = true # demo data
}

resource "aws_s3_bucket_public_access_block" "products" {
  bucket                  = aws_s3_bucket.products.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "products" {
  bucket = aws_s3_bucket.products.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "products" {
  bucket = aws_s3_bucket.products.id
  rule {
    id     = "drop-unconfirmed-uploads"
    status = "Enabled"
    filter { prefix = "tmp/" }
    expiration { days = 1 }
  }
}

# Browsers upload straight to S3 with presigned PUT URLs from the product service.
resource "aws_s3_bucket_cors_configuration" "products" {
  bucket = aws_s3_bucket.products.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = ["https://${aws_cloudfront_distribution.main.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Only THIS CloudFront distribution may read, and only products/ (not tmp/).
data "aws_iam_policy_document" "products_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.products.arn}/products/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "products" {
  bucket = aws_s3_bucket.products.id
  policy = data.aws_iam_policy_document.products_bucket.json
}

# ---------------- CloudFront: the public HTTPS front door ----------------
resource "aws_cloudfront_origin_access_control" "products" {
  name                              = "${local.name}-products"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS-managed policies (fixed IDs).
locals {
  cache_disabled        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  cache_optimized       = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
}

# Accepted: default *.cloudfront.net certificate (no custom domain) => AWS sets the
# TLS policy; no WAF (not available on our plan); no access logs (cost).
#trivy:ignore:AWS-0010
#trivy:ignore:AWS-0011
#trivy:ignore:AWS-0013
resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "ShopFlow stage2"
  price_class     = "PriceClass_200" # includes India
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }
  }

  origin {
    origin_id                = "products"
    domain_name              = aws_s3_bucket.products.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.products.id
  }

  # API: never cached, every method, all viewer headers/cookies/query strings.
  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_disabled
    origin_request_policy_id = local.all_viewer_except_host
    compress                 = true
  }

  # Product images: cached at the edge (the API lives under /v1, so no clash).
  ordered_cache_behavior {
    path_pattern           = "/products/*"
    target_origin_id       = "products"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized
    compress               = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

locals {
  public_url = "https://${aws_cloudfront_distribution.main.domain_name}"
}
