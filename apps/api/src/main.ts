import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  console.log(`🚀 API ready on http://localhost:${port}/api`);
}

bootstrap();
