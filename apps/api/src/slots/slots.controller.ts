import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { GetSlotsSchema, HoldSlotSchema } from '@clinic/shared';
import { z } from 'zod';
import { Public, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SlotsService } from './slots.service';

const DateQuery = GetSlotsSchema.pick({ date: true });
const RangeQuery = z.object({ from: DateQuery.shape.date, to: DateQuery.shape.date });
const HoldBody = HoldSlotSchema.pick({ holderKey: true });

@Controller()
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  @Public()
  @Get('doctors/:doctorId/slots')
  available(
    @Param('doctorId') doctorId: string,
    @Query(new ZodValidationPipe(DateQuery)) query: z.infer<typeof DateQuery>,
  ) {
    return this.slots.listAvailable(doctorId, query.date);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Get('doctors/:doctorId/slots/all')
  all(
    @Param('doctorId') doctorId: string,
    @Query(new ZodValidationPipe(RangeQuery)) query: z.infer<typeof RangeQuery>,
  ) {
    return this.slots.listForDoctor(doctorId, query.from, query.to);
  }

  @Post('slots/:slotId/hold')
  @HttpCode(200)
  hold(@Param('slotId') slotId: string, @Body(new ZodValidationPipe(HoldBody)) body: z.infer<typeof HoldBody>) {
    return this.slots.hold(slotId, body.holderKey);
  }

  @Delete('slots/:slotId/hold')
  release(@Param('slotId') slotId: string, @Body(new ZodValidationPipe(HoldBody)) body: z.infer<typeof HoldBody>) {
    return this.slots.releaseHold(slotId, body.holderKey);
  }

  @Roles('ADMIN')
  @Post('slots/generate')
  @HttpCode(200)
  generate() {
    return this.slots.syncAllDoctors();
  }
}
