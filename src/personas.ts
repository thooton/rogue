import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomCountryAndName } from "./identity-data.js";
import {
  builtinPersonas,
  randomPersonality,
  type PersonalityDefinition,
} from "./personality.js";

export interface PersonaTemplate {
  id: string;
  label: string;
  description: string;
  traits: string[];
  personality: PersonalityDefinition;
  createdBy: string;
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  personaId: string;
  personaLabel: string;
  personaDescription: string;
  traits: string[];
  personality: PersonalityDefinition;
  createdBy: string;
  createdAt: string;
}

export interface ProfileCandidate {
  name: string;
  country: string;
  countryCode: string;
  personaId: string;
  personaLabel: string;
  personaDescription: string;
  traits: string[];
  personality: PersonalityDefinition;
}

function rowString(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

function toPersona(row: Record<string, unknown>): PersonaTemplate {
  return {
    id: rowString(row, "id"),
    label: rowString(row, "label"),
    description: rowString(row, "description"),
    traits: JSON.parse(rowString(row, "traits")) as string[],
    personality: JSON.parse(rowString(row, "personality")) as PersonalityDefinition,
    createdBy: rowString(row, "created_by"),
    createdAt: rowString(row, "created_at"),
  };
}

function toProfile(row: Record<string, unknown>): AgentProfile {
  return {
    id: rowString(row, "id"),
    name: rowString(row, "name"),
    country: rowString(row, "country"),
    countryCode: rowString(row, "country_code"),
    personaId: rowString(row, "persona_id"),
    personaLabel: rowString(row, "persona_label"),
    personaDescription: rowString(row, "persona_description"),
    traits: JSON.parse(rowString(row, "traits")) as string[],
    personality: JSON.parse(rowString(row, "personality")) as PersonalityDefinition,
    createdBy: rowString(row, "created_by"),
    createdAt: rowString(row, "created_at"),
  };
}

export class PersonaDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;

  private constructor(databasePath: string) {
    this.path = databasePath;
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS persona_templates (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        traits TEXT NOT NULL,
        personality TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_profile (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        country TEXT NOT NULL,
        country_code TEXT NOT NULL,
        persona_id TEXT NOT NULL REFERENCES persona_templates(id),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.seedBuiltins();
    this.database.exec(`
      CREATE TRIGGER IF NOT EXISTS persona_templates_no_update
      BEFORE UPDATE ON persona_templates BEGIN
        SELECT RAISE(ABORT, 'persona templates are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS persona_templates_no_delete
      BEFORE DELETE ON persona_templates BEGIN
        SELECT RAISE(ABORT, 'persona templates are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS agent_profile_no_update
      BEFORE UPDATE ON agent_profile BEGIN
        SELECT RAISE(ABORT, 'the agent profile is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS agent_profile_no_delete
      BEFORE DELETE ON agent_profile BEGIN
        SELECT RAISE(ABORT, 'the agent profile is immutable');
      END;
    `);
  }

  static async open(stateDirectory: string): Promise<PersonaDatabase> {
    const directory = path.resolve(stateDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new PersonaDatabase(path.join(directory, "rogue.db"));
  }

  close(): void {
    this.database.close();
  }

  private seedBuiltins(): void {
    const insert = this.database.prepare(
      "INSERT OR IGNORE INTO persona_templates (id, label, description, traits, personality, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'system', ?)",
    );
    const now = new Date().toISOString();
    for (const persona of builtinPersonas()) {
      insert.run(
        persona.id,
        persona.label,
        persona.description,
        JSON.stringify(persona.traits),
        JSON.stringify(persona.personality),
        now,
      );
    }
  }

  listPersonas(): PersonaTemplate[] {
    const rows = this.database.prepare("SELECT * FROM persona_templates ORDER BY created_at, label").all();
    return rows.map((row) => toPersona(row as Record<string, unknown>));
  }

  createPersona(input: {
    label: string;
    description: string;
    traits: string[];
    personality?: PersonalityDefinition;
    createdBy: string;
  }): PersonaTemplate {
    const persona: PersonaTemplate = {
      id: `persona_${crypto.randomUUID()}`,
      label: input.label.trim(),
      description: input.description.trim(),
      traits: input.traits.map((trait) => trait.trim()).filter(Boolean),
      personality: input.personality ?? randomPersonality(),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare("INSERT INTO persona_templates (id, label, description, traits, personality, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        persona.id,
        persona.label,
        persona.description,
        JSON.stringify(persona.traits),
        JSON.stringify(persona.personality),
        persona.createdBy,
        persona.createdAt,
      );
    return persona;
  }

  generateCandidates(count = 4, random: () => number = Math.random): ProfileCandidate[] {
    const personas = this.listPersonas();
    if (personas.length === 0) throw new Error("No persona templates are available.");
    const requested = Math.max(0, Math.floor(count));
    return Array.from({ length: requested }, (_, index) => {
      const identity = randomCountryAndName(random, index);
      const personaIndex = (Math.floor(random() * personas.length) + index) % personas.length;
      const persona = personas[personaIndex]!;
      return {
        ...identity,
        personaId: persona.id,
        personaLabel: persona.label,
        personaDescription: persona.description,
        traits: persona.traits,
        personality: persona.personality,
      };
    });
  }

  createAgent(candidate: ProfileCandidate, options: { createdBy: string }): AgentProfile {
    if (this.getAgentProfile()) throw new Error("This Rogue installation already has its one immutable agent profile.");
    const profileId = `agent_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.database
      .prepare("INSERT INTO agent_profile (singleton, id, name, country, country_code, persona_id, created_by, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        profileId,
        candidate.name,
        candidate.country,
        candidate.countryCode,
        candidate.personaId,
        options.createdBy,
        createdAt,
      );
    const profile = this.getAgentProfile();
    if (!profile) throw new Error("The new agent profile could not be loaded.");
    return profile;
  }

  getAgentProfile(): AgentProfile | undefined {
    const row = this.database.prepare(`
      SELECT agent.*, personas.label AS persona_label,
             personas.description AS persona_description,
             personas.traits AS traits, personas.personality AS personality
      FROM agent_profile AS agent
      JOIN persona_templates AS personas ON personas.id = agent.persona_id
      WHERE agent.singleton = 1
    `).get();
    return row ? toProfile(row as Record<string, unknown>) : undefined;
  }
}
