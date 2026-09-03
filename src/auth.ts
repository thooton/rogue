import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Api,
  Model,
  Models,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import { RogueConfigStore } from "./config.js";
import { createRogueModels } from "./provider-runtime.js";
import {
  CUSTOM_PROVIDER_APIS,
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  normalizeCustomBaseUrl,
  saveCustomProvider,
  suggestCustomProviderId,
  type CustomProviderApi,
  type CustomProviderDefinition,
  type CustomProviderStore,
} from "./custom-providers.js";
import * as ui from "./ui.js";

export interface CatalogChoice {
  id: string;
  label: string;
  description?: string;
  searchText?: string;
  badge?: string;
  detail?: string[];
}

export function filterCatalogChoices<T extends CatalogChoice>(choices: readonly T[], query: string): T[] {
  return ui.filterItems(choices, query);
}

export function paginateCatalogChoices<T>(choices: readonly T[], page: number, pageSize = 12): {
  items: T[];
  page: number;
  pages: number;
} {
  const pages = Math.max(1, Math.ceil(choices.length / pageSize));
  const bounded = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  return { items: choices.slice(bounded * pageSize, (bounded + 1) * pageSize), page: bounded, pages };
}

/** Providers whose stored or ambient credentials already resolve, for the "ready" badge. */
async function detectConfiguredProviders(models: Models): Promise<Set<string>> {
  const providers = models.getProviders();
  const detected = new Set<string>();
  const checks = providers.map(async (provider) => {
    const check = await models.checkAuth(provider.id).catch(() => undefined);
    if (check) detected.add(provider.id);
  });
  // Some providers resolve ambient credentials through slow external tooling, so
  // the badge is best-effort: whatever has not answered in time simply lacks it.
  await Promise.race([
    Promise.allSettled(checks),
    new Promise((resolve) => setTimeout(resolve, 3_000).unref?.()),
  ]);
  return detected;
}

/** Sentinel choice that opens the custom-endpoint flow instead of selecting a provider. */
export const ADD_CUSTOM_PROVIDER = "+custom";

export function customProviderChoice(): CatalogChoice {
  return {
    id: ADD_CUSTOM_PROVIDER,
    badge: "custom",
    label: `${ui.style.accent("+")}  Add a local or custom endpoint`,
    description: "Any OpenAI- or Anthropic-compatible URL · Ollama, llama.cpp, vLLM, LM Studio, a proxy, or a private gateway",
    searchText: "custom local endpoint base url self-hosted ollama llamacpp llama.cpp vllm sglang lm studio openai compatible proxy gateway offline",
  };
}

export function providerCatalogChoices(models: Models, configured: ReadonlySet<string> = new Set()): CatalogChoice[] {
  return models.getProviders().map((provider) => {
    const auth = [
      provider.auth.apiKey ? `API: ${provider.auth.apiKey.name}` : undefined,
      provider.auth.oauth
        ? `Sign-in${provider.auth.oauth.isSubscription ? " subscription" : ""}: ${provider.auth.oauth.loginLabel ?? provider.auth.oauth.name}`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    const count = models.getModels(provider.id).length;
    const ready = configured.has(provider.id);
    return {
      id: provider.id,
      badge: provider.id,
      label: `${provider.name}${ready ? `  ${ui.style.success("● credentials found")}` : ""}`,
      description: `${auth.join(" · ")} · ${count ? `${count} models` : "dynamic model catalog"}`,
      searchText: `${auth.join(" ")} ${ready ? "ready configured authenticated" : ""}`,
    };
  }).sort((a, b) => {
    const readyDifference = Number(configured.has(b.id)) - Number(configured.has(a.id));
    return readyDifference || a.id.localeCompare(b.id);
  });
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function modelCatalogChoices(models: readonly Model<Api>[]): CatalogChoice[] {
  return models.map((model) => ({
    id: model.id,
    badge: model.id,
    label: `${model.name || model.id}${model.reasoning ? `  ${ui.style.info("◈ reasoning")}` : ""}`,
    description: `${formatTokens(model.contextWindow)} context · ${formatTokens(model.maxTokens)} max output · ${model.api}`,
    searchText: `${model.provider} ${model.api} ${model.reasoning ? "reasoning thinking" : ""}`,
  })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

async function choose<T extends CatalogChoice>(
  title: string,
  allChoices: readonly T[],
  options: { subtitle?: string; confirmLabel?: string } = {},
): Promise<T> {
  if (!allChoices.length) throw new Error(`No choices are available for ${title.toLocaleLowerCase()}.`);
  return ui.select({
    title,
    subtitle: options.subtitle,
    confirmLabel: options.confirmLabel,
    items: allChoices,
  });
}

function notify(event: AuthEvent): void {
  if (event.type === "auth_url") {
    ui.write();
    ui.heading("Open this URL in your browser", event.instructions);
    ui.write(`  ${ui.style.info(ui.style.underline(event.url))}`);
    ui.write();
  } else if (event.type === "device_code") {
    ui.write();
    ui.heading("Device sign-in", `Enter the code at ${event.verificationUri}`);
    ui.write(`  ${ui.style.bold(ui.style.accent(event.userCode))}`);
    ui.write();
  } else if (event.type === "progress") {
    ui.hint(event.message);
  } else if (event.type === "info") {
    ui.info(event.message);
    for (const link of event.links ?? []) ui.hint(`${link.label ?? "More information"}: ${link.url}`);
  }
}

async function promptForAuth(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const selected = await choose(prompt.message, prompt.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
    })));
    return selected.id;
  }
  if (prompt.type === "secret") return ui.secret(prompt.message, prompt.signal);
  return ui.text({
    label: prompt.message,
    placeholder: prompt.placeholder,
    signal: prompt.signal,
    allowEmpty: true,
  });
}

function createInteraction(): AuthInteraction {
  return { prompt: promptForAuth, notify };
}

type AuthenticationChoice = AuthType | "existing";

async function selectAuthentication(provider: Provider, models: Models, forced?: AuthType): Promise<AuthenticationChoice> {
  const existing = await models.checkAuth(provider.id).catch(() => undefined);
  const choices: CatalogChoice[] = [];
  if (existing) choices.push({
    id: "existing",
    label: "Use detected credentials",
    badge: "no sign-in needed",
    description: `${existing.type === "oauth" ? "Signed-in account" : "API or local credentials"}${existing.source ? ` · ${existing.source}` : ""}`,
  });
  if (provider.auth.oauth) choices.push({
    id: "oauth",
    label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
    badge: provider.auth.oauth.isSubscription ? "subscription" : "oauth",
    description: provider.auth.oauth.isSubscription ? "Uses an existing provider subscription" : "Browser or device sign-in",
  });
  if (provider.auth.apiKey?.login) choices.push({
    id: "api_key",
    label: provider.auth.apiKey.name,
    badge: "api key",
    description: "Provider-guided credential setup · input stays hidden",
  });
  if (forced) {
    const match = choices.find((choice) => choice.id === forced);
    if (!match) throw new Error(`${provider.name} does not support interactive ${forced === "oauth" ? "account sign-in" : "API credential setup"}.`);
    return forced;
  }
  if (!choices.length) {
    throw new Error(`${provider.name} requires ambient credentials, but none were detected. Configure the provider's system credentials and try again.`);
  }
  if (choices.length === 1) {
    ui.success(`${ui.style.faint("Authentication ·")} ${ui.style.bold(choices[0]!.label)}`);
    return choices[0]!.id as AuthenticationChoice;
  }
  const chosen = await choose(`How should Rogue authenticate with ${provider.name}?`, choices, {
    subtitle: "Every method below is supported by this provider.",
    confirmLabel: "Authentication",
  });
  return chosen.id as AuthenticationChoice;
}

async function availableModels(models: Models, provider: Provider): Promise<readonly Model<Api>[]> {
  // The refresh error is reported after the spinner stops; anything printed
  // while it animates is erased by the next frame.
  const { candidates, error } = await ui.withSpinner(
    `Loading ${provider.name}'s model catalog…`,
    async () => {
      const refresh = await models.refresh({ providers: [provider.id], force: true });
      return { candidates: await models.getAvailable(provider.id), error: refresh.errors.get(provider.id) };
    },
    (result) => `${result.candidates.length} model${result.candidates.length === 1 ? "" : "s"} available for these credentials.`,
  );
  if (error) ui.warn(`Could not refresh ${provider.name}'s catalog: ${error.message}`);
  return candidates;
}

const API_CHOICES: CatalogChoice[] = [
  {
    id: "openai-completions",
    badge: "openai-completions",
    label: "OpenAI-compatible chat completions",
    description: "POST /chat/completions · what Ollama, llama.cpp, vLLM, SGLang, LM Studio, and most proxies serve",
  },
  {
    id: "openai-responses",
    badge: "openai-responses",
    label: "OpenAI Responses",
    description: "POST /responses · endpoints emulating OpenAI's newer surface",
  },
  {
    id: "anthropic-messages",
    badge: "anthropic-messages",
    label: "Anthropic Messages",
    description: "POST /v1/messages · endpoints emulating Anthropic's surface",
  },
];

async function promptForTokenCount(label: string, fallback: number): Promise<number> {
  const answer = await ui.text({
    label,
    placeholder: `(Enter for ${fallback.toLocaleString("en-US")})`,
    allowEmpty: true,
    validate: (value) => {
      if (!value) return undefined;
      const parsed = Number(value.replaceAll(/[,_\s]/g, ""));
      return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : "Enter a positive whole number of tokens.";
    },
  });
  return answer ? Number(answer.replaceAll(/[,_\s]/g, "")) : fallback;
}

/**
 * Define one endpoint Pi has never heard of. Everything asked for here is
 * something the endpoint itself cannot be trusted to report: a served model's
 * real context window is the usual example, and a wrong guess is only found
 * later, as a rejected request in the middle of an unattended cycle.
 */
async function promptForCustomProvider(
  models: MutableModels,
  store: CustomProviderStore,
): Promise<CustomProviderDefinition> {
  ui.heading(
    "Local or custom endpoint",
    "Point Rogue at any OpenAI- or Anthropic-compatible server, including one running on this machine.",
  );
  const baseUrl = await ui.text({
    label: "Base URL",
    placeholder: "(e.g. http://127.0.0.1:11434/v1)",
    hint: "Use the same root a client would: usually the one ending in /v1.",
    validate: (value) => {
      try {
        normalizeCustomBaseUrl(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  const stored = new Set((await store.list()).map((definition) => definition.id));
  const suggestedId = suggestCustomProviderId(baseUrl, new Set(models.getProviders().map((provider) => provider.id)));
  const id = (await ui.text({
    label: "Provider ID",
    placeholder: `(Enter for ${suggestedId})`,
    allowEmpty: true,
    validate: (value) => {
      if (value && models.getProvider(value.toLocaleLowerCase()) && !stored.has(value.toLocaleLowerCase())) {
        return `${value} already belongs to a built-in Pi provider. Choose another ID.`;
      }
      return undefined;
    },
  })).toLocaleLowerCase() || suggestedId;
  const suggestedName = new URL(baseUrl).host;
  const name = (await ui.text({
    label: "Display name",
    placeholder: `(Enter for ${suggestedName})`,
    allowEmpty: true,
  })) || suggestedName;
  const api = (await choose("Which API does this endpoint speak?", API_CHOICES, {
    subtitle: "Pick the request format the server accepts, not the model family it runs.",
    confirmLabel: "API",
  })).id as CustomProviderApi;
  const contextWindow = await promptForTokenCount(
    "Context window",
    DEFAULT_CUSTOM_CONTEXT_WINDOW,
  );
  const requiresApiKey = await ui.confirm("Does this endpoint require an API key?", false);

  const definition = await saveCustomProvider(models, store, { id, name, baseUrl, api, contextWindow, requiresApiKey });
  if (requiresApiKey) {
    await models.login(definition.id, "api_key", createInteraction());
    ui.success(`Stored a credential for ${ui.style.bold(name)}.`);
  }
  ui.panel("Custom endpoint saved", [
    ["Provider", `${name} ${ui.style.faint(definition.id)}`],
    ["Base URL", definition.baseUrl],
    ["API", api],
    ["Context", `${contextWindow.toLocaleString("en-US")} tokens`],
    ["Credential", requiresApiKey ? "stored API key" : ui.style.faint("none required")],
    ["Definition", store.path],
  ]);
  return definition;
}

/**
 * A server without a catalog endpoint is still perfectly usable — it just has
 * to be told what it serves, since nothing else can find out.
 */
async function promptForCustomModel(
  models: MutableModels,
  store: CustomProviderStore,
  definition: CustomProviderDefinition,
): Promise<readonly Model<Api>[]> {
  ui.warn(`${definition.name ?? definition.id} did not return a model catalog. Name the model it serves instead.`);
  const modelId = await ui.text({
    label: "Model ID",
    placeholder: "(exactly as the endpoint names it)",
    hint: "For example qwen3-coder:30b on Ollama, or the served-model-name a vLLM instance was started with.",
  });
  await saveCustomProvider(models, store, { ...definition, models: [{ id: modelId }] });
  return models.getAvailable(definition.id);
}

interface ProviderSetupOptions {
  stateDirectory?: string;
  provider?: string;
  model?: string;
  authType?: AuthType;
  offerFallbacks?: boolean;
  /** Set during first-run onboarding so the flow shows its place in the sequence. */
  onboarding?: boolean;
}

/** Interactive provider authentication and model selection shared by first-run and --auth. */
export async function runProviderSetup(options: ProviderSetupOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("Provider setup needs an interactive terminal. Run Rogue directly in a terminal.");
  const directory = options.stateDirectory ?? ".rogue";
  const { models, credentials, customProviders } = await createRogueModels(directory);
  const config = new RogueConfigStore(directory);
  let presetProvider = options.provider;
  let presetModel = options.model;
  let configureAnother = true;
  let configuredCount = 0;

  if (!options.onboarding) ui.logo("model providers · authentication · routing");
  ui.heading(
    "Model setup",
    "Pick any supported provider, sign in with what you already have, then choose its model.",
  );

  const detected = await ui.withSpinner("Reading the provider catalog…", async () => {
    await models.refresh({ allowNetwork: false });
    return detectConfiguredProviders(models);
  }, (found) => {
    const total = models.getProviders().length;
    return `${total} providers available${found.size ? ` · ${found.size} already have credentials` : ""}.`;
  });

  while (configureAnother) {
    let created: CustomProviderDefinition | undefined;
    let selectedId = presetProvider;
    if (!selectedId) {
      selectedId = (await choose("Choose a provider", [customProviderChoice(), ...providerCatalogChoices(models, detected)], {
        subtitle: "Providers with usable credentials are listed first; the first entry accepts any endpoint URL.",
        confirmLabel: "Provider",
      })).id;
      if (selectedId === ADD_CUSTOM_PROVIDER) {
        created = await promptForCustomProvider(models, customProviders);
        selectedId = created.id;
      }
    }
    const provider = models.getProvider(selectedId);
    if (!provider) throw new Error(`Unknown Pi provider: ${selectedId}`);
    if (presetProvider) ui.success(`${ui.style.faint("Provider ·")} ${ui.style.bold(provider.name)} ${ui.style.faint(provider.id)}`);

    // A just-created endpoint has already answered the credential question, so
    // asking again would only offer the choice it was configured with.
    if (!created) {
      const authentication = await selectAuthentication(provider, models, options.authType);
      if (authentication !== "existing") {
        await models.login(provider.id, authentication, createInteraction());
        ui.success(`Authenticated ${ui.style.bold(provider.name)}.`);
      }
    }

    let candidates = await availableModels(models, provider);
    if (!candidates.length && created) candidates = await promptForCustomModel(models, customProviders, created);
    if (!candidates.length) throw new Error(`No models are available for ${provider.name} after authentication.`);
    let model: Model<Api> | undefined;
    if (presetModel) {
      model = candidates.find((candidate) => candidate.id === presetModel);
      if (!model) throw new Error(`Model ${provider.id}/${presetModel} is not available for these credentials.`);
      ui.success(`${ui.style.faint("Model ·")} ${ui.style.bold(model.name || model.id)} ${ui.style.faint(model.id)}`);
    } else {
      const choice = await choose(`Choose a ${provider.name} model`, modelCatalogChoices(candidates), {
        subtitle: "Only models your credentials can reach are listed.",
        confirmLabel: "Model",
      });
      model = candidates.find((candidate) => candidate.id === choice.id);
    }
    if (!model) throw new Error(`Could not select a model for ${provider.name}.`);

    const routes = await config.listProviders();
    const existing = routes.find((route) => route.provider === provider.id && route.model === model!.id);
    const priority = existing?.priority ?? (routes.length ? Math.max(...routes.map((route) => route.priority)) + 10 : 0);
    await config.configureProvider({ provider: provider.id, model: model.id, priority });
    configuredCount += 1;

    ui.panel(configuredCount === 1 ? "Primary route ready" : "Fallback route ready", [
      ["Provider", `${provider.name} ${ui.style.faint(provider.id)}`],
      ["Model", `${model.name || model.id} ${ui.style.faint(model.id)}`],
      ["Context", `${formatTokens(model.contextWindow)} tokens · ${formatTokens(model.maxTokens)} max output`],
      ["Priority", `${priority} ${ui.style.faint("(lower runs first)")}`],
      ["Credentials", credentials.path],
    ]);

    presetProvider = undefined;
    presetModel = undefined;
    if (!options.offerFallbacks) break;
    configureAnother = await ui.confirm("Add another provider as a fallback route?", false);
  }

  const finalRoutes = await config.listProviders();
  if (finalRoutes.length > 1) {
    ui.info(`Failover order: ${finalRoutes.map((route) => `${route.provider}/${route.model}`).join(ui.style.faint(" → "))}`);
    ui.write();
  }
}

export async function runAuthentication(provider?: string, stateDirectory?: string, model?: string): Promise<void> {
  await runProviderSetup({ provider, model, stateDirectory, offerFallbacks: true });
}

export async function runApiKeySetup(provider: string, model?: string, stateDirectory?: string): Promise<void> {
  await runProviderSetup({ provider, model, stateDirectory, authType: "api_key" });
}
