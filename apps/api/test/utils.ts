import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { AUTH_PROVIDER, AuthProvider } from '../src/auth/auth.provider';
import { PrismaService } from '../src/prisma/prisma.module';
import { RedisService } from '../src/redis/redis.module';
import { SlotsService } from '../src/slots/slots.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  slots: SlotsService;
  auth: AuthProvider;
}

export async function createTestApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<TestContext> {
  const moduleRef = await configure(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  // The test database is ours alone, so start every suite from empty.
  await prisma.$executeRawUnsafe(
    'TRUNCATE approval_requests, agent_sessions, payments, bookings, slots, doctor_leaves, doctor_working_hours, doctors, patients, users CASCADE',
  );
  await app.get(RedisService).client.flushdb();

  return { app, prisma, slots: app.get(SlotsService), auth: app.get(AUTH_PROVIDER) };
}

export async function createUser(ctx: TestContext, role: 'ADMIN' | 'DOCTOR') {
  const password = randomUUID();
  const user = await ctx.prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@clinic.test`,
      name: `Test ${role}`,
      role,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  const { accessToken } = await ctx.auth.login(user.email, password);
  return { user, password, token: accessToken };
}

/** A doctor working 09:00-12:00 every day, with real generated slots. */
export async function createDoctorWithSlots(ctx: TestContext, userId?: string) {
  const doctor = await ctx.prisma.doctor.create({
    data: {
      name: `Dr. Test ${randomUUID().slice(0, 8)}`,
      specialization: 'Testing',
      feeInr: 700,
      slotMinutes: 30,
      userId,
      workingHours: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '12:00' })),
      },
    },
  });
  await ctx.slots.syncDoctorSlots(doctor.id);
  return doctor;
}

/** Hands out a different free slot each call so tests do not share state. */
export function slotPicker(ctx: TestContext, doctorId: string) {
  const used = new Set<string>();
  return async () => {
    const slot = await ctx.prisma.slot.findFirstOrThrow({
      where: { doctorId, status: 'FREE', id: { notIn: [...used] } },
      orderBy: { startTime: 'asc' },
    });
    used.add(slot.id);
    return slot;
  };
}

let phoneCounter = 0;
export function nextPhone(): string {
  phoneCounter += 1;
  return `98765${String(phoneCounter).padStart(5, '0')}`;
}

export const newKey = () => randomUUID();
