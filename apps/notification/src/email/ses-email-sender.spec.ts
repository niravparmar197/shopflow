import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PermanentEmailError } from './email-sender';
import { SesEmailSender } from './ses-email-sender';

describe('SesEmailSender', () => {
  const config = {
    get: (k: string) =>
      ({
        MAIL_FROM: 'ShopFlow <shop@example.com>',
        SES_REGION: 'ap-southeast-2',
      })[k],
  };
  const make = (send: jest.Mock) => {
    const sender = new SesEmailSender(config as never);
    (sender as unknown as { client: { send: jest.Mock } }).client = { send };
    return sender;
  };
  const msg = {
    to: 'asha@shop.in',
    subject: 'Hi',
    text: 'plain',
    html: '<p>html</p>',
    headers: { 'X-Notification-Key': 'k1' },
  };

  it('sends text + html from MAIL_FROM, with our headers', async () => {
    const send = jest.fn().mockResolvedValue({ MessageId: 'm-1' });
    await expect(make(send).send(msg)).resolves.toEqual({ messageId: 'm-1' });

    const cmd = send.mock.calls[0][0] as SendEmailCommand;
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input).toMatchObject({
      FromEmailAddress: 'ShopFlow <shop@example.com>',
      Destination: { ToAddresses: ['asha@shop.in'] },
      Content: {
        Simple: {
          Subject: { Data: 'Hi' },
          Body: { Text: { Data: 'plain' }, Html: { Data: '<p>html</p>' } },
          Headers: [{ Name: 'X-Notification-Key', Value: 'k1' }],
        },
      },
    });
  });

  it('a rejected message is permanent (no retry)', async () => {
    const err = Object.assign(new Error('Email address is not verified'), {
      name: 'MessageRejected',
    });
    await expect(
      make(jest.fn().mockRejectedValue(err)).send(msg),
    ).rejects.toBeInstanceOf(PermanentEmailError);
  });

  it('throttling stays a normal error, so BullMQ retries it', async () => {
    const err = Object.assign(new Error('Maximum sending rate exceeded'), {
      name: 'TooManyRequestsException',
    });
    await expect(make(jest.fn().mockRejectedValue(err)).send(msg)).rejects.toBe(
      err,
    );
  });
});
