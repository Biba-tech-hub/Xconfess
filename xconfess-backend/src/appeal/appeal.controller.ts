import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AppealService } from './appeal.service';
import { CreateAppealDto, ResolveAppealDto } from './dto/appeal.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

@ApiTags('Appeals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('appeals')
export class AppealController {
  constructor(private readonly appealService: AppealService) {}

  @Post()
  @ApiOperation({ summary: 'Submit an appeal contesting a moderation outcome' })
  submitAppeal(@Req() req: any, @Body() dto: CreateAppealDto) {
    return this.appealService.submitAppeal(String(req.user.id), dto);
  }

  @Get('my-appeals')
  @ApiOperation({ summary: 'List user submitted appeals with SLA and transparent status' })
  listMyAppeals(@Req() req: any) {
    return this.appealService.listUserAppeals(String(req.user.id));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details and public status of an appeal (internal notes redacted)' })
  getAppeal(@Req() req: any, @Param('id') id: string) {
    return this.appealService.getAppealForUser(String(req.user.id), id);
  }

  @Get('staff/queue')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Staff queue of appeals prioritized by SLA and escalation' })
  getStaffQueue(@Query('escalated') escalated?: string) {
    return this.appealService.getStaffQueue(escalated === 'true');
  }

  @Patch(':id/assign')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Assign a staff reviewer to an appeal' })
  assignReviewer(@Req() req: any, @Param('id') id: string) {
    return this.appealService.assignReviewer(id, String(req.user.id));
  }

  @Patch(':id/resolve')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Resolve an appeal with public explanation and internal staff notes' })
  resolveAppeal(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ResolveAppealDto,
  ) {
    return this.appealService.resolveAppeal(id, String(req.user.id), dto);
  }
}
