import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TokensService } from './tokens.service';

@ApiTags('Tokens')
@Controller('api/v1/tokens')
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Get()
  @ApiOperation({ summary: 'List tracked tokens' })
  async list() {
    const tokens = await this.tokensService.findAll();
    return tokens.map((t) => this.toDto(t));
  }

  @Get(':chainId/:tokenAddress')
  @ApiOperation({ summary: 'Get token metadata' })
  async getOne(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('tokenAddress') tokenAddress: string,
  ) {
    const token = await this.tokensService.findOne(chainId, tokenAddress);
    return this.toDto(token);
  }

  private toDto(t: {
    chainId: number;
    tokenAddress: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    deploymentBlock: string;
    enabled: boolean;
  }) {
    return {
      chainId: t.chainId,
      tokenAddress: t.tokenAddress,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      deploymentBlock: t.deploymentBlock,
      enabled: t.enabled,
    };
  }
}
