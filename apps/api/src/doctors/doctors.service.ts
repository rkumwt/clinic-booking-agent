import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  CreateDoctorInput,
  CreateLeaveInput,
  SearchDoctorsInput,
  UpdateDoctorInput,
  WorkingHoursInput,
} from '@clinic/shared';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.module';
import { SlotsService } from '../slots/slots.service';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  specialization: true,
  feeInr: true,
  slotMinutes: true,
  bio: true,
  isActive: true,
} as const;

@Injectable()
export class DoctorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: SlotsService,
  ) {}

  search(query: SearchDoctorsInput, includeInactive = false) {
    return this.prisma.doctor.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(query.specialization
          ? { specialization: { contains: query.specialization, mode: 'insensitive' as const } }
          : {}),
        ...(query.name ? { name: { contains: query.name, mode: 'insensitive' as const } } : {}),
      },
      select: PUBLIC_FIELDS,
      orderBy: { name: 'asc' },
    });
  }

  async get(id: string) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      select: {
        ...PUBLIC_FIELDS,
        workingHours: {
          select: { weekday: true, startTime: true, endTime: true },
          orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
        },
      },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');
    return doctor;
  }

  async create(input: CreateDoctorInput) {
    const email = input.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const doctor = await this.prisma.doctor.create({
      data: {
        name: input.name,
        specialization: input.specialization,
        feeInr: input.feeInr,
        slotMinutes: input.slotMinutes,
        bio: input.bio,
        user: { create: { email, passwordHash, name: input.name, role: 'DOCTOR' } },
        workingHours: { create: input.workingHours },
      },
      select: PUBLIC_FIELDS,
    });
    await this.slots.syncDoctorSlots(doctor.id);
    return doctor;
  }

  async update(id: string, input: UpdateDoctorInput) {
    await this.get(id);
    const doctor = await this.prisma.doctor.update({ where: { id }, data: input, select: PUBLIC_FIELDS });
    const slots = await this.slots.syncDoctorSlots(id);
    return { ...doctor, slots };
  }

  async setWorkingHours(id: string, hours: WorkingHoursInput[], actor: AuthUser) {
    await this.assertCanManage(id, actor);
    await this.prisma.$transaction([
      this.prisma.doctorWorkingHours.deleteMany({ where: { doctorId: id } }),
      this.prisma.doctorWorkingHours.createMany({ data: hours.map((h) => ({ ...h, doctorId: id })) }),
    ]);
    const slots = await this.slots.syncDoctorSlots(id);
    return { ...(await this.get(id)), slots };
  }

  async listLeaves(id: string, actor: AuthUser) {
    await this.assertCanManage(id, actor);
    return this.prisma.doctorLeave.findMany({ where: { doctorId: id }, orderBy: { startDate: 'asc' } });
  }

  async addLeave(id: string, input: CreateLeaveInput, actor: AuthUser) {
    await this.assertCanManage(id, actor);
    const leave = await this.prisma.doctorLeave.create({
      data: {
        doctorId: id,
        startDate: new Date(`${input.startDate}T00:00:00Z`),
        endDate: new Date(`${input.endDate}T00:00:00Z`),
        reason: input.reason,
      },
    });
    // `slots.conflicts` tells the caller how many existing bookings fall inside the leave.
    const slots = await this.slots.syncDoctorSlots(id);
    return { ...leave, slots };
  }

  async removeLeave(id: string, leaveId: string, actor: AuthUser) {
    await this.assertCanManage(id, actor);
    const { count } = await this.prisma.doctorLeave.deleteMany({ where: { id: leaveId, doctorId: id } });
    if (count === 0) throw new NotFoundException('Leave not found');
    const slots = await this.slots.syncDoctorSlots(id);
    return { deleted: true, slots };
  }

  /** Admins manage any doctor; a doctor manages only their own profile. */
  async assertCanManage(doctorId: string, actor: AuthUser) {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId }, select: { userId: true } });
    if (!doctor) throw new NotFoundException('Doctor not found');
    if (actor.role === 'ADMIN') return;
    if (actor.role === 'DOCTOR' && doctor.userId === actor.id) return;
    throw new ForbiddenException('You can only manage your own schedule');
  }
}
