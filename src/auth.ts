import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Api,
  Model,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "./credentials.js";
import { FileModelsStore } from "./model-catalog-store.js";
import { RogueConfigStore } from "./config.js";
import { initializeBundledProviderRuntime } from "./provider-runtime.js";
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
  initializeBundledProviderRuntime();
  const directory = options.stateDirectory ?? ".rogue";
  const credentials = new FileCredentialStore(`${directory}/auth.json`);
  const modelsStore = new FileModelsStore(`${directory}/model-catalogs.json`);
  const models = builtinModels({ credentials, modelsStore });
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
    const provider = presetProvider
      ? models.getProvider(presetProvider)
      : models.getProvider((await choose("Choose a provider", providerCatalogChoices(models, detected), {
        subtitle: "Providers with usable credentials are listed first.",
        confirmLabel: "Provider",
      })).id);
    if (!provider) throw new Error(`Unknown Pi provider: ${presetProvider}`);
    if (presetProvider) ui.success(`${ui.style.faint("Provider ·")} ${ui.style.bold(provider.name)} ${ui.style.faint(provider.id)}`);

    const authentication = await selectAuthentication(provider, models, options.authType);
    if (authentication !== "existing") {
      await models.login(provider.id, authentication, createInteraction());
      ui.success(`Authenticated ${ui.style.bold(provider.name)}.`);
    }

    const candidates = await availableModels(models, provider);
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
