import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import {
  ApiError,
  CurrentUser,
  JwtAuthGuard,
  type JwtPayload,
} from '@app/common';
import { AddressesService, toAddressResponse } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

// The caller's own address book; the user id comes from the token only.
@ApiTags('Addresses')
@ApiBearerAuth()
@ApiError(401, 'UNAUTHORIZED (missing or expired token)')
@Controller('users/me/addresses')
@UseGuards(JwtAuthGuard)
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  /** Your saved addresses, the default first */
  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    return {
      items: (await this.addresses.list(user.sub)).map(toAddressResponse),
    };
  }

  /** Save an address (the first one becomes the default) */
  @Post()
  @ApiError(400, 'BAD_REQUEST (validation: phone, pincode, lengths)')
  @ApiError(409, 'ADDRESS_LIMIT (10 addresses max)')
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAddressDto) {
    return toAddressResponse(await this.addresses.create(user.sub, dto));
  }

  /** Edit an address, or make it the default with { isDefault: true } */
  @Patch(':id')
  @ApiError(400, 'BAD_REQUEST (validation)')
  @ApiError(404, "ADDRESS_NOT_FOUND (also for other users' addresses)")
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return toAddressResponse(await this.addresses.update(user.sub, id, dto));
  }

  /** Delete an address (past orders keep their own copy) */
  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiError(404, "ADDRESS_NOT_FOUND (also for other users' addresses)")
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.addresses.remove(user.sub, id);
  }
}
