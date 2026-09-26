import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Query,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SearchDiscoveryService } from './search-discovery.service';
import { CreateSavedSearchDto } from './dto/create-saved-search.dto';
import { SearchConfessionDto } from '../confession/dto/search-confession.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestCost, COST } from '../common/guards/cost-throttler.guard';

@ApiTags('Search Discovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('confessions/search/discovery')
export class SearchDiscoveryController {
  constructor(private readonly service: SearchDiscoveryService) {}

  @Get()
  @RequestCost(COST.MEDIUM) // full-text search + filtering is more expensive than a simple read
  @ApiOperation({ summary: 'Execute full text search with filters and highlighting' })
  executeSearch(
    @Req() req: any,
    @Query() query: SearchConfessionDto,
  ) {
    return this.service.executeFullTextSearch(req.user.id, query);
  }

  @Post('presets')
  @ApiOperation({ summary: 'Save a search preset' })
  savePreset(@Req() req: any, @Body() dto: CreateSavedSearchDto) {
    return this.service.savePreset(req.user.id, dto);
  }

  @Get('presets')
  @ApiOperation({ summary: 'List saved search presets' })
  listPresets(@Req() req: any) {
    return this.service.listPresets(req.user.id);
  }

  @Delete('presets/:id')
  @ApiOperation({ summary: 'Delete a search preset' })
  deletePreset(@Req() req: any, @Param('id') id: string) {
    return this.service.deletePreset(req.user.id, id);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get recent search history' })
  getHistory(@Req() req: any) {
    return this.service.getRecentSearches(req.user.id);
  }

  @Get('recommendations')
  @ApiOperation({ summary: 'Get personalized recommendations with safeguards and explanations' })
  getRecommendations(@Req() req: any, @Query('limit') limit?: number) {
    return this.service.getPersonalizedRecommendations(req.user.id, limit);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get user discovery personalization and diversity preferences' })
  getPreferences(@Req() req: any) {
    return this.service.getUserDiscoveryPreference(req.user.id);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update personalization opt-out and diversity preferences' })
  updatePreferences(@Req() req: any, @Body() dto: any) {
    return this.service.updateUserDiscoveryPreference(req.user.id, dto);
  }
}