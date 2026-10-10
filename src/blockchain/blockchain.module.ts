import { Module } from "@nestjs/common";
import { RpcClientFactory } from "./rpc-client.factory";
import { Erc20Reader } from "./erc20.reader";
import { TransferLogReader } from "./transfer-log.reader";
import { BalanceRewindService } from "./balance-rewind.service";

@Module({
  providers: [
    RpcClientFactory,
    Erc20Reader,
    TransferLogReader,
    BalanceRewindService,
  ],
  exports: [
    RpcClientFactory,
    Erc20Reader,
    TransferLogReader,
    BalanceRewindService,
  ],
})
export class BlockchainModule {}
