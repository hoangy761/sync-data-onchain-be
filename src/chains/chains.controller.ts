import { Controller, Get, Param, ParseIntPipe } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ChainsService } from "./chains.service";

@ApiTags("Chains")
@Controller("api/v1/chains")
export class ChainsController {
  constructor(private readonly chainsService: ChainsService) {}

  @Get()
  @ApiOperation({ summary: "List indexed chains" })
  @ApiOkResponse({ description: "Chain list" })
  async list() {
    const chains = await this.chainsService.findAll();
    return chains.map((c) => ({
      chainId: c.chainId,
      name: c.name,
      // rpcUrl: c.rpcUrl ,
      rpcUrl: "********",
      enabled: c.enabled,
    }));
  }

  @Get(":chainId")
  @ApiOperation({ summary: "Get chain by id" })
  async getOne(@Param("chainId", ParseIntPipe) chainId: number) {
    const c = await this.chainsService.findOne(chainId);
    return {
      chainId: c.chainId,
      name: c.name,
      rpcUrl: "********",
      enabled: c.enabled,
    };
  }
}
