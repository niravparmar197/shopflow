import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const users = {
    create: jest.fn(),
    findByEmail: jest.fn(),
    toPublic: jest.fn((u: { id: string; email: string }) => ({
      id: u.id,
      email: u.email,
    })),
  };
  const account = { requestVerification: jest.fn() };
  const em = {};
  const ds = { transaction: jest.fn((fn: (m: object) => unknown) => fn(em)) };
  const service = new AuthService(users as any, account as any, ds as any);

  const storedUser = async (overrides: object = {}) => ({
    id: '1',
    email: 'a@b.com',
    passwordHash: await bcrypt.hash('secret123', 4),
    isActive: true,
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it('hashes the password on signup', async () => {
    users.create.mockImplementation((d: object) =>
      Promise.resolve({ id: '1', ...d }),
    );
    await service.signup({
      email: 'a@b.com',
      password: 'secret123',
      name: 'A',
    });
    const [[saved]] = users.create.mock.calls as [[{ passwordHash: string }]];
    expect(saved.passwordHash).not.toBe('secret123');
    expect(await bcrypt.compare('secret123', saved.passwordHash)).toBe(true);
    // Same transaction: the verify email can't be lost (or sent for no user).
    expect(users.create).toHaveBeenCalledWith(expect.anything(), em);
    expect(account.requestVerification).toHaveBeenCalledWith(
      em,
      expect.objectContaining({ id: '1' }),
    );
  });

  it('returns the public user for correct credentials', async () => {
    users.findByEmail.mockResolvedValue(await storedUser());
    await expect(
      service.validateCredentials({ email: 'a@b.com', password: 'secret123' }),
    ).resolves.toEqual({ id: '1', email: 'a@b.com' });
  });

  it('rejects wrong password', async () => {
    users.findByEmail.mockResolvedValue(await storedUser());
    await expect(
      service.validateCredentials({ email: 'a@b.com', password: 'wrong1234' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects unknown email with the same error', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(
      service.validateCredentials({ email: 'x@b.com', password: 'secret123' }),
    ).rejects.toThrow('Invalid email or password');
  });

  it('rejects a deactivated user with the same error', async () => {
    users.findByEmail.mockResolvedValue(await storedUser({ isActive: false }));
    await expect(
      service.validateCredentials({ email: 'a@b.com', password: 'secret123' }),
    ).rejects.toThrow('Invalid email or password');
  });
});
