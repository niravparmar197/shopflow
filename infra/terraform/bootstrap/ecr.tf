resource "aws_ecr_repository" "app" {
  for_each             = toset(var.apps)
  name                 = "shopflow/${each.key}"
  image_tag_mutability = "IMMUTABLE" # tag = git sha, can never be overwritten
  force_delete         = true        # `terraform destroy` works even with images inside

  image_scanning_configuration { scan_on_push = true }
}

# Storage costs money (free tier is small): keep the current image + one for rollback.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "delete untagged layers after 1 day"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "keep the last 2 images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 2 }
        action       = { type = "expire" }
      },
    ]
  })
}
