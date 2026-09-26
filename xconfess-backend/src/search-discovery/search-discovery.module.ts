import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchDiscoveryService } from './search-discovery.service';
import { SearchDiscoveryController } from './search-discovery.controller';
import { SavedSearch } from './entities/saved-search.entity';
import { SearchHistory } from './entities/search-history.entity';
import { SearchAbuseGuard } from './search-abuse.guard';

@Module({
  imports: [TypeOrmModule.forFeature([SavedSearch, SearchHistory])],
  providers: [SearchDiscoveryService, SearchAbuseGuard],
  controllers: [SearchDiscoveryController],
  exports: [SearchDiscoveryService, SearchAbuseGuard],
})
export class SearchDiscoveryModule {}

