import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { DoctorsModule } from '../doctors/doctors.module';
import { SlotsModule } from '../slots/slots.module';
import { AgentSessionsService } from './agent-sessions.service';
import { AgentController } from './agent.controller';
import { agentProviders } from './agent.providers';
import { AgentService } from './agent.service';
import { ClinicBackendAdapter } from './clinic-backend.adapter';
import { FaqService } from './faq.service';

@Module({
  imports: [DoctorsModule, SlotsModule, BookingsModule],
  controllers: [AgentController],
  providers: [...agentProviders, AgentService, AgentSessionsService, ClinicBackendAdapter, FaqService],
  exports: [AgentService],
})
export class AgentModule {}
