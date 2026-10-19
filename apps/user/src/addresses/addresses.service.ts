import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Address } from '../entities/address.entity';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

export const MAX_ADDRESSES = 10;

/** The public shape (no userId: it is always the caller). */
export const toAddressResponse = (a: Address) => ({
  id: a.id,
  fullName: a.fullName,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  pincode: a.pincode,
  isDefault: a.isDefault,
  createdAt: a.createdAt,
});

/**
 * The address book. Exactly one default while the user has any address:
 * the first one becomes the default, a new default takes over from the old
 * one, and deleting the default promotes the newest remaining address.
 * A partial unique index (one is_default per user) guards it in the DB.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(Address) private readonly repo: Repository<Address>,
  ) {}

  /** Default first, then newest. */
  list(userId: string) {
    return this.repo.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  create(userId: string, dto: CreateAddressDto) {
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(Address);
      // One address-book change per user at a time (an advisory lock, held
      // until commit): two parallel creates can't both pass the limit check
      // or both become the first (default) address. Row locks can't do this
      // when the user has no rows yet.
      await this.lockBook(m, userId);
      const existing = await repo.find({ where: { userId } });
      if (existing.length >= MAX_ADDRESSES) {
        throw new ConflictException({
          code: 'ADDRESS_LIMIT',
          message: `You can save up to ${MAX_ADDRESSES} addresses`,
        });
      }
      const isDefault = existing.length === 0 || dto.isDefault === true;
      if (isDefault) await this.clearDefault(m, userId);
      return repo.save(
        repo.create({ ...dto, line2: dto.line2 || null, userId, isDefault }),
      );
    });
  }

  update(userId: string, id: string, dto: UpdateAddressDto) {
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(Address);
      await this.lockBook(m, userId);
      const address = await this.findMine(m, userId, id);
      // Un-setting the only default would leave none: ignore isDefault: false.
      const { isDefault, ...fields } = dto;
      Object.assign(address, fields);
      if (fields.line2 !== undefined) address.line2 = fields.line2 || null;
      if (isDefault && !address.isDefault) {
        await this.clearDefault(m, userId);
        address.isDefault = true;
      }
      return repo.save(address);
    });
  }

  remove(userId: string, id: string) {
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(Address);
      await this.lockBook(m, userId);
      const address = await this.findMine(m, userId, id);
      await repo.delete({ id: address.id });
      if (address.isDefault) {
        const next = await repo.findOne({
          where: { userId },
          order: { createdAt: 'DESC' },
        });
        if (next) await repo.update({ id: next.id }, { isDefault: true });
      }
    });
  }

  /** Someone else's address is a 404, not a 403 (don't reveal it exists). */
  private async findMine(m: EntityManager, userId: string, id: string) {
    const address = await m
      .getRepository(Address)
      .findOne({ where: { id, userId } });
    if (!address) {
      throw new NotFoundException({
        code: 'ADDRESS_NOT_FOUND',
        message: 'Address not found',
      });
    }
    return address;
  }

  private lockBook(m: EntityManager, userId: string) {
    return m.query(
      `SELECT pg_advisory_xact_lock(hashtext('address-book:' || $1::text))`,
      [userId],
    );
  }

  private clearDefault(m: EntityManager, userId: string) {
    return m
      .getRepository(Address)
      .update({ userId, isDefault: true }, { isDefault: false });
  }
}
