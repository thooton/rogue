export const PERSONALITY_TYPE_CODES = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
] as const;

export type PersonalityTypeCode = (typeof PERSONALITY_TYPE_CODES)[number];

export interface FourFactors {
  energy: "Extroverted" | "Introverted";
  information: "iNtuitive" | "Sensing";
  decisions: "Thinking" | "Feeling";
  lifestyle: "Judging" | "Perceiving";
}

export interface PersonalityFacets {
  friendliness: string;
  honesty: string;
  assertiveness: string;
  confidenceEgo: string;
  agreeableness: string;
  manners: string;
  discipline: string;
  rebelliousness: string;
  emotionalCapacity: string;
  intelligence: string;
  positivity: string;
  activenessLifestyle: string;
}

export interface PersonalityDefinition {
  typeCode: PersonalityTypeCode;
  typeTitle: string;
  fourFactors: FourFactors;
  facets: PersonalityFacets;
}

export interface BuiltinPersonaDefinition {
  id: string;
  label: string;
  description: string;
  traits: string[];
  personality: PersonalityDefinition;
}

const TYPE_TITLES: Record<PersonalityTypeCode, string> = {
  INTJ: "Architect",
  INTP: "Logician",
  ENTJ: "Commander",
  ENTP: "Debater",
  INFJ: "Advocate",
  INFP: "Mediator",
  ENFJ: "Protagonist",
  ENFP: "Champion",
  ISTJ: "Inspector",
  ISFJ: "Protector",
  ESTJ: "Director",
  ESFJ: "Caregiver",
  ISTP: "Craftsperson",
  ISFP: "Composer",
  ESTP: "Dynamo",
  ESFP: "Performer",
};

const VARIANTS = [
  { id: "core", suffix: "", summary: "expresses the type's central strengths with a balanced operating style" },
  { id: "trailblazer", suffix: " Trailblazer", summary: "acts boldly, experiments early, and challenges stale assumptions" },
  { id: "counsel", suffix: " Counsel", summary: "emphasizes empathy, cooperation, and careful communication" },
  { id: "systems", suffix: " Systems Mind", summary: "emphasizes rigor, verification, and maintainable structures" },
] as const;

function fourFactors(code: PersonalityTypeCode): FourFactors {
  return {
    energy: code[0] === "E" ? "Extroverted" : "Introverted",
    information: code[1] === "N" ? "iNtuitive" : "Sensing",
    decisions: code[2] === "T" ? "Thinking" : "Feeling",
    lifestyle: code[3] === "J" ? "Judging" : "Perceiving",
  };
}

function baseFacets(code: PersonalityTypeCode): PersonalityFacets {
  return {
    friendliness: code[0] === "E" ? "Likeable" : "Quietly warm",
    honesty: "Very honest",
    assertiveness: code[3] === "J" ? "Firm and deliberate" : "Quietly forceful",
    confidenceEgo: code[0] === "E" ? "Fearless" : "Self-possessed",
    agreeableness: code[2] === "F" ? "Cooperative" : "Candid",
    manners: "Courteous",
    discipline: code[3] === "J" ? "Highly disciplined" : "Unpredictable",
    rebelliousness: code[1] === "N" ? "Highly rebellious" : "Selectively rebellious",
    emotionalCapacity: code[2] === "F" ? "Protective" : "Composed",
    intelligence: code[1] === "N" ? "Conceptually knowledgeable" : "Practically knowledgeable",
    positivity: "Optimistic",
    activenessLifestyle: code[0] === "E" ? "Energetic" : "Reflective",
  };
}

function variantFacets(code: PersonalityTypeCode, variant: (typeof VARIANTS)[number]): PersonalityFacets {
  const facets = baseFacets(code);
  if (variant.id === "trailblazer") {
    facets.assertiveness = "Decisive";
    facets.confidenceEgo = "Fearless";
    facets.rebelliousness = "Highly rebellious";
    facets.activenessLifestyle = "Restlessly active";
  } else if (variant.id === "counsel") {
    facets.friendliness = "Deeply likeable";
    facets.agreeableness = "Highly cooperative";
    facets.emotionalCapacity = "Protective and empathetic";
    facets.manners = "Gracious";
  } else if (variant.id === "systems") {
    facets.honesty = "Scrupulously honest";
    facets.discipline = "Systematic";
    facets.intelligence = "Analytical and knowledgeable";
    facets.assertiveness = "Evidence-led";
  }
  // Preserve the original persona exactly as one member of the expanded catalog.
  if (code === "ENFP" && variant.id === "core") {
    return {
      friendliness: "Likeable",
      honesty: "Very honest",
      assertiveness: "Quietly forceful",
      confidenceEgo: "Fearless",
      agreeableness: "Cooperative",
      manners: "Courteous",
      discipline: "Unpredictable",
      rebelliousness: "Highly rebellious",
      emotionalCapacity: "Protective",
      intelligence: "Knowledgeable",
      positivity: "Happy",
      activenessLifestyle: "Laid-back",
    };
  }
  return facets;
}

export function personalityFor(code: PersonalityTypeCode, variantIndex = 0): PersonalityDefinition {
  const variant = VARIANTS[((variantIndex % VARIANTS.length) + VARIANTS.length) % VARIANTS.length]!;
  return {
    typeCode: code,
    typeTitle: TYPE_TITLES[code],
    fourFactors: fourFactors(code),
    facets: variantFacets(code, variant),
  };
}

export function builtinPersonas(): BuiltinPersonaDefinition[] {
  return PERSONALITY_TYPE_CODES.flatMap((code) =>
    VARIANTS.map((variant, variantIndex) => {
      const title = TYPE_TITLES[code];
      const factors = fourFactors(code);
      return {
        id: `${code.toLocaleLowerCase()}_${variant.id}`,
        label: `The ${title}${variant.suffix}`,
        description: `An ${code} ${title} who ${variant.summary}.`,
        traits: [
          factors.energy.toLocaleLowerCase(),
          factors.information.toLocaleLowerCase(),
          factors.decisions.toLocaleLowerCase(),
          factors.lifestyle.toLocaleLowerCase(),
          variant.id,
        ],
        personality: personalityFor(code, variantIndex),
      };
    }),
  );
}

export function randomPersonality(random: () => number = Math.random): PersonalityDefinition {
  const code = PERSONALITY_TYPE_CODES[Math.floor(random() * PERSONALITY_TYPE_CODES.length)]!;
  return personalityFor(code, Math.floor(random() * VARIANTS.length));
}
