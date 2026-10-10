import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BalancesService } from './balances.service';

@ApiTags('Balances')
@Controller('api/v1/tokens')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get(':chainId/:tokenAddress/holders/:holderAddress/balance')
  @ApiOperation({ summary: 'Get current holder balance' })
  getBalance(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('tokenAddress') tokenAddress: string,
    @Param('holderAddress') holderAddress: string,
  ) {
    return this.balancesService.getBalance(
      chainId,
      tokenAddress,
      holderAddress,
    );
  }

  @Get(':chainId/:tokenAddress/holders/:holderAddress/history')
  @ApiOperation({ summary: 'Get holder balance history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  getHistory(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('tokenAddress') tokenAddress: string,
    @Param('holderAddress') holderAddress: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.balancesService.getHistory(
      chainId,
      tokenAddress,
      holderAddress,
      limit,
      cursor,
    );
  }
}
