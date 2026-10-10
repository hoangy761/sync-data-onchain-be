import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ERC-20 Balance Indexer API')
    .setDescription(
      'API for current ERC-20 holder balances, balance history, and sync status.',
    )
    .setVersion('1.0.0')
    .addTag('Health')
    .addTag('Chains')
    .addTag('Tokens')
    .addTag('Balances')
    .addTag('Sync')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const config = app.get(ConfigService);
  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Indexer listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`Swagger UI at http://localhost:${port}/docs`);
}

void bootstrap();
