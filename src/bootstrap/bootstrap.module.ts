import { Module } from '@nestjs/common';
import { ChainsModule } from '../chains/chains.module';
import { TokensModule } from '../tokens/tokens.module';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [ChainsModule, TokensModule],
  providers: [BootstrapService],
  exports: [BootstrapService],
})
export class BootstrapModule {}
