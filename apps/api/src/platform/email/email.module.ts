import { Global, Injectable, Module } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../../config/app-config.js';

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Puerto de envío de email. El dominio depende de esta interfaz, no de un proveedor concreto
 * (blueprint §3: "adaptadores para proveedores externos"). La Fase 5 añadirá el outbox por encima.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** Adaptador SMTP (Mailpit en local; cualquier SMTP/relay en producción). */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: AppConfig) {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = config.env;
    this.from = MAIL_FROM;
    this.transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
      connectionTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

@Global()
@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: SmtpEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
