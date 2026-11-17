import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  AuthUser,
  BookingStatus,
  CancelBookingInput,
  CancelBookingSchema,
  ConfirmBookingInput,
  ConfirmBookingSchema,
  RescheduleBookingInput,
  RescheduleBookingSchema,
} from '@clinic/shared';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BookingsService } from './bookings.service';

const ListQuery = z.object({
  status: BookingStatus.optional(),
  doctorId: z.string().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Roles('ADMIN', 'DOCTOR')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.bookings.list(user, query);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.bookings.get(id);
  }

  @Post()
  confirm(@Body(new ZodValidationPipe(ConfirmBookingSchema)) body: ConfirmBookingInput) {
    return this.bookings.confirm(body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelBookingSchema)) body: CancelBookingInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.cancel(id, body.reason, user, body.phone);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  reschedule(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RescheduleBookingSchema)) body: RescheduleBookingInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bookings.reschedule(id, body.newSlotId, body.holderKey, user, body.phone);
  }
}
