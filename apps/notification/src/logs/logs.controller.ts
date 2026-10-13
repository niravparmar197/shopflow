import {
  Controller,
  Get,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard, Roles, RolesGuard } from '@app/common';
import { NotificationLog } from './notification-log.schema';

/** For support: "what did we send for this order?" Admins only. */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class LogsController {
  constructor(
    @InjectModel(NotificationLog.name)
    private readonly logs: Model<NotificationLog>,
  ) {}

  @Get()
  byOrder(@Query('orderId', ParseUUIDPipe) orderId: string) {
    return this.logs
      .find(
        { orderId },
        {
          _id: 0,
          key: 1,
          template: 1,
          channel: 1,
          to: 1,
          status: 1,
          attempts: 1,
          lastError: 1,
          sentAt: 1,
          createdAt: 1,
        },
      )
      .sort({ createdAt: 1 })
      .lean();
  }
}
