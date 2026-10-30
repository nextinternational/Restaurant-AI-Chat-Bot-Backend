import { ObjectId, type WithId } from "mongodb";
import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import type { RetentionDefaults } from "../db/retention.js";
import { retentionPolicy } from "../db/retention.js";
import type { RestaurantId } from "../domain/ids.js";
import { MAX_MESSAGE_CHARS, type Conversation, type Message, type Restaurant } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import { generateSessionToken, hashToken } from "../security/tokens.js";

export class ConversationRepository {
  private readonly conversations: ScopedCollection<Conversation>;
  private readonly messages: ScopedCollection<Message>;
  private readonly policy: ReturnType<typeof retentionPolicy>;

  constructor(
    cols: Collections,
    restaurantId: RestaurantId,
    defaults: RetentionDefaults,
    restaurant?: Pick<Restaurant, "retention">,
  ) {
    this.conversations = new ScopedCollection(cols.conversations, restaurantId);
    this.messages = new ScopedCollection(cols.messages, restaurantId);
    this.policy = retentionPolicy(defaults, restaurant);
  }

  /** Returns the plaintext token ONCE (to hand to the client); only its SHA-256 is stored. */
  async start(widgetKeyId?: string, now = new Date()): Promise<{ conversationId: ObjectId; sessionToken: string }> {
    const sessionToken = generateSessionToken();
    const res = await this.conversations.insertOne({
      sessionTokenHash: hashToken(sessionToken),
      ...(widgetKeyId ? { widgetKeyId } : {}),
      status: "active",
      messageCount: 0,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: this.policy.conversationExpiry(now),
    });
    return { conversationId: res.insertedId, sessionToken };
  }

  /** A token minted for restaurant A cannot match here for restaurant B: the lookup is tenant-scoped. */
  findBySessionToken(token: unknown): Promise<WithId<Conversation> | null> {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return Promise.resolve(null);
    return this.conversations.findOne({ sessionTokenHash: hashToken(token) });
  }

  async appendMessage(
    conversationId: ObjectId,
    msg: { role: Message["role"]; content: string; toolName?: string },
    now = new Date(),
  ): Promise<void> {
    if (msg.content.length < 1 || msg.content.length > MAX_MESSAGE_CHARS) {
      throw new AppError(400, "bad_message", "Message length out of range");
    }
    // Verify the conversation belongs to this tenant BEFORE writing a message that references it.
    if ((await this.conversations.countDocuments({ _id: conversationId })) !== 1) {
      throw new AppError(404, "not_found", "Conversation not found");
    }
    await this.messages.insertOne({
      conversationId,
      role: msg.role,
      content: msg.content,
      ...(msg.toolName ? { toolName: msg.toolName } : {}),
      createdAt: now,
      expiresAt: this.policy.messageExpiry(now),
    });
    // Activity extends the conversation's retention window.
    await this.conversations.updateOne(
      { _id: conversationId },
      { $inc: { messageCount: 1 }, $set: { lastActivityAt: now, expiresAt: this.policy.conversationExpiry(now) } },
    );
  }

  recentMessages(conversationId: ObjectId, limit = 10): Promise<Message[]> {
    return this.messages
      .find({ conversationId }, { limit, sort: { createdAt: -1 } })
      .then((rows) => rows.reverse());
  }

  async setSummary(conversationId: ObjectId, summary: string): Promise<void> {
    await this.conversations.updateOne({ _id: conversationId }, { $set: { summary: summary.slice(0, 4000) } });
  }

  async close(conversationId: ObjectId, now = new Date()): Promise<boolean> {
    const res = await this.conversations.updateOne(
      { _id: conversationId, status: { $ne: "closed" } },
      { $set: { status: "closed", lastActivityAt: now } },
    );
    return res.modifiedCount === 1;
  }
}
