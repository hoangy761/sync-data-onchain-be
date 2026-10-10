import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncService } from './sync.service';

@ApiTags('Sync')
@Controller('api/v1/tokens')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get(':chainId/:tokenAddress/sync-status')
  @ApiOperation({ summary: 'Get sync progress for a token' })
  getStatus(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('tokenAddress') tokenAddress: string,
  ) {
    return this.syncService.getSyncStatus(chainId, tokenAddress);
  }
}
