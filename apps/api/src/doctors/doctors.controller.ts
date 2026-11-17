import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  AuthUser,
  CreateDoctorInput,
  CreateDoctorSchema,
  CreateLeaveInput,
  CreateLeaveSchema,
  SearchDoctorsInput,
  SearchDoctorsSchema,
  SetWorkingHoursInput,
  SetWorkingHoursSchema,
  UpdateDoctorInput,
  UpdateDoctorSchema,
} from '@clinic/shared';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DoctorsService } from './doctors.service';

@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Public()
  @Get()
  search(
    @Query(new ZodValidationPipe(SearchDoctorsSchema)) query: SearchDoctorsInput,
    @CurrentUser() user?: AuthUser,
  ) {
    // Only admins see deactivated doctors.
    return this.doctors.search(query, user?.role === 'ADMIN');
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.doctors.get(id);
  }

  @Roles('ADMIN')
  @Post()
  create(@Body(new ZodValidationPipe(CreateDoctorSchema)) body: CreateDoctorInput) {
    return this.doctors.create(body);
  }

  @Roles('ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateDoctorSchema)) body: UpdateDoctorInput) {
    return this.doctors.update(id, body);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Put(':id/working-hours')
  setWorkingHours(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetWorkingHoursSchema)) body: SetWorkingHoursInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.doctors.setWorkingHours(id, body.workingHours, user);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Get(':id/leaves')
  listLeaves(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.doctors.listLeaves(id, user);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Post(':id/leaves')
  addLeave(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateLeaveSchema)) body: CreateLeaveInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.doctors.addLeave(id, body, user);
  }

  @Roles('ADMIN', 'DOCTOR')
  @Delete(':id/leaves/:leaveId')
  removeLeave(@Param('id') id: string, @Param('leaveId') leaveId: string, @CurrentUser() user: AuthUser) {
    return this.doctors.removeLeave(id, leaveId, user);
  }
}
