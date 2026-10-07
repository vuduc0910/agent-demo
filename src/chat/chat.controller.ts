import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';
import { ChatService } from './chat.service.js';
import { SKIP_CHAT_THROTTLE } from './chat.throttle.js';

const message = z.string().trim().min(1).max(1000);
const StartChatSchema = z.object({
  customerId: z
    .string()
    .regex(/^cus_[a-z0-9]{1,32}$/)
    .nullable(),
  message,
});
const ChatMessageSchema = z.object({ message });
type StartChatDto = z.infer<typeof StartChatSchema>;
type ChatMessageDto = z.infer<typeof ChatMessageSchema>;

const ticketId = { schema: z.string().regex(/^[a-z0-9_]{1,64}$/) };

@Controller('chat')
@UseGuards(ThrottlerGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('customers')
  @SkipThrottle(SKIP_CHAT_THROTTLE)
  customers() {
    return this.chat.customers();
  }

  @Post('tickets')
  start(@Body({ schema: StartChatSchema }) body: StartChatDto) {
    return this.chat.start(body.customerId, body.message);
  }

  @Get('tickets/:id')
  @SkipThrottle(SKIP_CHAT_THROTTLE)
  get(@Param('id', ticketId) id: string) {
    return this.chat.get(id);
  }

  @Post('tickets/:id/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  send(
    @Param('id', ticketId) id: string,
    @Body({ schema: ChatMessageSchema }) body: ChatMessageDto,
  ) {
    return this.chat.send(id, body.message);
  }
}
