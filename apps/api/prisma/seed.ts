import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { addDays, localDateString } from '../src/common/time';
import { Shift, generateSlots } from '../src/slots/slot-generator';

// Safe to re-run: everything is upserted, and slots use skipDuplicates.

const prisma = new PrismaClient();
const TIMEZONE = process.env.CLINIC_TIMEZONE ?? 'Asia/Kolkata';
const DAYS = Number(process.env.SLOT_GENERATION_DAYS ?? 14);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env before seeding`);
  return value;
}

const weekdays = (days: number[], startTime: string, endTime: string): Shift[] =>
  days.map((weekday) => ({ weekday, startTime, endTime }));

const MON_FRI = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];

const DOCTORS = [
  {
    name: 'Dr. Ananya Sharma',
    email: 'ananya.sharma@clinic.test',
    specialization: 'General Medicine',
    feeInr: 500,
    slotMinutes: 20,
    bio: 'General physician with 12 years of experience in family medicine.',
    hours: [...weekdays(MON_SAT, '09:00', '13:00'), ...weekdays(MON_FRI, '17:00', '20:00')],
  },
  {
    name: 'Dr. Rohan Mehta',
    email: 'rohan.mehta@clinic.test',
    specialization: 'Cardiology',
    feeInr: 1200,
    slotMinutes: 30,
    bio: 'Interventional cardiologist. Heart check-ups, ECG and echo reviews.',
    hours: weekdays([1, 3, 5], '10:00', '14:00'),
  },
  {
    name: 'Dr. Priya Nair',
    email: 'priya.nair@clinic.test',
    specialization: 'Dermatology',
    feeInr: 800,
    slotMinutes: 20,
    bio: 'Dermatologist treating acne, eczema, hair fall and skin allergies.',
    hours: weekdays([2, 4, 6], '11:00', '16:00'),
  },
  {
    name: 'Dr. Vikram Iyer',
    email: 'vikram.iyer@clinic.test',
    specialization: 'Pediatrics',
    feeInr: 600,
    slotMinutes: 20,
    bio: 'Pediatrician. Vaccinations, growth checks and childhood illnesses.',
    hours: [...weekdays(MON_FRI, '09:30', '12:30'), ...weekdays(MON_FRI, '16:00', '19:00')],
  },
  {
    name: 'Dr. Sana Khan',
    email: 'sana.khan@clinic.test',
    specialization: 'Orthopedics',
    feeInr: 900,
    slotMinutes: 30,
    bio: 'Orthopedic surgeon. Joint pain, fractures and sports injuries.',
    hours: weekdays([1, 2, 4, 6], '14:00', '18:00'),
  },
];

const FAQS = [
  {
    title: 'Clinic timings',
    content:
      'CityCare Clinic is open Monday to Saturday, 9:00 AM to 8:00 PM. The clinic is closed on Sundays and public holidays. Each doctor has their own consulting hours within these timings.',
  },
  {
    title: 'Address and directions',
    content:
      'CityCare Clinic is at 2nd Floor, Lotus Plaza, MG Road, Jaipur, Rajasthan 302001. It is a 5-minute walk from the MG Road metro station. Paid parking is available in the building basement.',
  },
  {
    title: 'Consultation fees',
    content:
      'Consultation fees depend on the doctor: General Medicine ₹500, Pediatrics ₹600, Dermatology ₹800, Orthopedics ₹900 and Cardiology ₹1200. The fee covers one consultation and one free follow-up within 7 days with the same doctor.',
  },
  {
    title: 'Cancellation policy',
    content:
      'You can cancel an appointment free of charge up to 4 hours before the appointment time and receive a full refund. Cancellations made less than 4 hours before the appointment are not refunded automatically and need approval from the clinic.',
  },
  {
    title: 'Rescheduling policy',
    content:
      'You can reschedule an appointment to another free slot with the same doctor at no extra cost, up to 2 hours before the appointment time. To see a different doctor, cancel the appointment and book a new one.',
  },
  {
    title: 'Refund timeline',
    content:
      'Approved refunds are sent back to the original payment method. They usually reach your account in 5 to 7 working days. All refunds are reviewed by the clinic staff before they are processed.',
  },
  {
    title: 'Payment methods',
    content:
      'You can pay online by UPI, credit card, debit card or net banking using the secure payment link sent after booking. An unpaid booking is held for 15 minutes and then released.',
  },
  {
    title: 'What to bring to your appointment',
    content:
      'Please bring a government photo ID, any previous prescriptions and medical reports, and a list of medicines you take. Arrive 10 minutes before your appointment time.',
  },
  {
    title: 'Emergencies',
    content:
      'CityCare Clinic does not handle medical emergencies. For chest pain, breathing difficulty, heavy bleeding or any other emergency, call 108 or go to the nearest hospital emergency department immediately.',
  },
  {
    title: 'Insurance and lab tests',
    content:
      'The clinic does not offer cashless insurance for consultations, but we give a stamped receipt you can submit to your insurer. Blood tests and ECG are done in-house from 8:00 AM to 12:00 PM; other tests are referred to partner labs.',
  },
];

async function main() {
  const adminEmail = requireEnv('SEED_ADMIN_EMAIL').toLowerCase();
  const adminHash = await bcrypt.hash(requireEnv('SEED_ADMIN_PASSWORD'), 10);
  const doctorHash = await bcrypt.hash(requireEnv('SEED_DOCTOR_PASSWORD'), 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    create: { email: adminEmail, passwordHash: adminHash, name: 'Clinic Admin', role: 'ADMIN' },
    update: { passwordHash: adminHash },
  });

  const today = localDateString(new Date(), TIMEZONE);
  let slotCount = 0;

  for (const [index, d] of DOCTORS.entries()) {
    const user = await prisma.user.upsert({
      where: { email: d.email },
      create: { email: d.email, passwordHash: doctorHash, name: d.name, role: 'DOCTOR' },
      update: { passwordHash: doctorHash, name: d.name },
    });
    const profile = {
      name: d.name,
      specialization: d.specialization,
      feeInr: d.feeInr,
      slotMinutes: d.slotMinutes,
      bio: d.bio,
    };
    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      create: { ...profile, userId: user.id },
      update: profile,
    });

    await prisma.doctorWorkingHours.deleteMany({ where: { doctorId: doctor.id } });
    await prisma.doctorWorkingHours.createMany({ data: d.hours.map((h) => ({ ...h, doctorId: doctor.id })) });

    // Give one doctor a two-day leave next week so "minus leaves" is visible in the data.
    const leaves =
      index === 1 ? [{ startDate: addDays(today, 7), endDate: addDays(today, 8), reason: 'Conference' }] : [];
    await prisma.doctorLeave.deleteMany({ where: { doctorId: doctor.id } });
    for (const l of leaves) {
      await prisma.doctorLeave.create({
        data: {
          doctorId: doctor.id,
          startDate: new Date(`${l.startDate}T00:00:00Z`),
          endDate: new Date(`${l.endDate}T00:00:00Z`),
          reason: l.reason,
        },
      });
    }

    const now = new Date();
    const slots = generateSlots({
      workingHours: d.hours,
      leaves,
      slotMinutes: d.slotMinutes,
      fromDate: today,
      days: DAYS,
      timezone: TIMEZONE,
    }).filter((s) => s.startTime > now);
    const created = await prisma.slot.createMany({
      data: slots.map((s) => ({ doctorId: doctor.id, ...s })),
      skipDuplicates: true,
    });
    slotCount += created.count;
  }

  // Embeddings are filled in by the FAQ indexing script (phase 3).
  for (const faq of FAQS) {
    await prisma.faqDocument.upsert({
      where: { title: faq.title },
      create: faq,
      update: { content: faq.content },
    });
  }

  console.log(
    `Seeded: 1 admin (${adminEmail}), ${DOCTORS.length} doctors, ${slotCount} new slots over ${DAYS} days, ${FAQS.length} FAQs.`,
  );
  console.log('Passwords are the SEED_ADMIN_PASSWORD / SEED_DOCTOR_PASSWORD values in your .env.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
