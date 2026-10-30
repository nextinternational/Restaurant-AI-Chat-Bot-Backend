import { createServer } from "node:http";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { connectMongo } from "./db/mongo.js";
import { assertSchemaCurrent } from "./db/migrate.js";
import { createApp } from "./app.js";
import { createRepositories } from "./repositories/index.js";
import { OpenAiProvider } from "./ai/openaiProvider.js";
import { UsageAdminService } from "./services/usage/usageAdminService.js";
import { createUsageGateway } from "./services/usage/gateway.js";
import { ChatService } from "./services/chat/chatService.js";
import { createChatGateway } from "./services/chat/gateway.js";
import { CatalogAdminService } from "./services/catalog/catalogAdminService.js";
import { createCatalogGateway } from "./services/catalog/gateway.js";
import { createKnowledgeGateway } from "./services/knowledge/gateway.js";
import { KnowledgeAdminService } from "./services/knowledge/knowledgeAdminService.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const database = await connectMongo(env);
  logger.info("connected to MongoDB");
  // Never serve traffic against an un-migrated database (missing validators / tenant indexes).
  await assertSchemaCurrent(database.db);

  const repos = createRepositories(database.db, env);
  let chat: Parameters<typeof createApp>[0]["chat"];
  if (env.OPENAI_API_KEY) {
    const gateway = createChatGateway(repos);
    const service = new ChatService(
      gateway,
      new OpenAiProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL, env.AI_REQUEST_TIMEOUT_MS),
      {
        maxMessagesPerConversation: env.CHAT_MAX_MESSAGES_PER_CONVERSATION,
        defaultMonthlyBudgetMicros: env.AI_DEFAULT_MONTHLY_BUDGET_MICROS,
        price: { inputMicrosPerMtok: env.AI_INPUT_COST_MICROS_PER_MTOK, outputMicrosPerMtok: env.AI_OUTPUT_COST_MICROS_PER_MTOK },
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS * 2,
        maxToolIterations: 4,
        historyLimit: 10,
        sessionIdleMs: env.CHAT_SESSION_IDLE_HOURS * 3_600_000,
      },
      logger,
    );
    chat = { service };
    logger.info({ model: env.OPENAI_MODEL }, "chat API enabled");
  } else {
    logger.warn("OPENAI_API_KEY is not set: the public chat API is disabled");
  }

  const app = createApp({
    env,
    logger,
    ...(chat ? { chat } : {}),
    // Menu/hours management does not need the AI: restaurants must be able to enter data BEFORE enabling chat.
    catalog: new CatalogAdminService(createCatalogGateway(repos), repos.accounts),
    // Like the catalog, FAQs and policies can be prepared before chat is enabled.
    knowledge: new KnowledgeAdminService(createKnowledgeGateway(repos), repos.accounts),
    // Cost reporting reads usage logs only, so it works with or without the AI key.
    usage: new UsageAdminService(createUsageGateway(repos)),
    accounts: repos.accounts,
    readinessChecks: [{ name: "mongodb", check: database.ping }],
  });

  const server = createServer(app);
  // Slowloris protection and sane timeouts.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000; // must exceed the AWS ALB idle timeout (60s)

  server.listen(env.PORT, () => logger.info({ port: env.PORT }, "server listening"));

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down gracefully");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => {
      database
        .close()
        .catch((err: unknown) => logger.error({ err }, "error closing MongoDB"))
        .finally(() => process.exit(exitCode));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandledRejection");
    shutdown("unhandledRejection", 1); // a crash must never report success to the orchestrator
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // Logger may not exist yet if config failed; stderr is the only safe place.
  process.stderr.write(`Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
