import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FormsService } from './forms.service';
import { FormsController, PublicFormsController } from './forms.controller';
import { SlaPolicyController } from './sla.controller';

@Module({
  imports: [AuthModule],
  controllers: [FormsController, PublicFormsController, SlaPolicyController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}
