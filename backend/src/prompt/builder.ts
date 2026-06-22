// Prompt builder — English-only prompts with language-dependent SFX
// Image generation trigger at BOTH top and bottom

const SFX_EXAMPLES: Record<string, string> = {
  ko: "Korean (콰광, 쾅, 스윽, 두근, 으악, 탁, 번쩍, 후우)",
  ja: "Japanese (ドカン, ザザザ, ススス, ドキドキ, ギャー, パリン, ピカッ, フゥー)",
  zh: "Chinese (轰, 咚, 嗖, 扑通, 啊, 哗啦, 闪光, 呼)",
  th: "Thai (บูม!, ตูม!, วู้ว!, ปึก!, ตลับ!, แร้ง!, ฉึง!)",
  en: "English (BOOM!, CRASH!, WHOOSH!, THUMP!, BAM!, SLASH!, CRACK!, WHIRL)",
  es: "Spanish (BOOM!, CRASH!, ZAS!, PUM!, CLANG!, WHOOSH!)",
  fr: "French (BOOM!, CRASH!, FOUISH!, BAM!, KLIRRSCH!, RUMS!)",
  pt: "Portuguese (BOOM!, CRASH!, ZUUUM!, BUM!, WHOOSH!)",
  de: "German (BOOM!, KRACH!, ZISCH!, BAM!, KLIRRSCH!, RUMS!)",
};

const TRIGGER_TOP = "##Edit image from the original image##\n\n";
const TRIGGER_BOTTOM = "\n\n##Edit image from the original image##";

export function buildPrompt(opts: {
  lang: string;
  langCode?: string;
  customPrompt?: string;
  textLayers?: string[];
  translateSfx?: boolean;
}): string {
  const { lang, langCode, customPrompt, textLayers, translateSfx } = opts;
  const sfx = translateSfx !== false;
  const sfxExamples = SFX_EXAMPLES[langCode || "en"] || SFX_EXAMPLES.en;
  const sfxInstruction = `SFX & Effects: Search thoroughly for ALL sound effects — ${sfxExamples}, or stylized text. Translate to ${lang} onomatopoeia matching the vibe. Replicate the original font effects.`;

  // Case 1: Has text layers overlapping selection
  if (textLayers && textLayers.length > 0) {
    const textList = textLayers.map((t) => `- ${t}`).join("\n");
    const sfxPart = sfx ? `\n\nAlso search for and translate ALL SFX/effect text. ${sfxInstruction}` : "";

    return (
      TRIGGER_TOP +
      `This is a manhwa/comic panel.\n` +
      `Translate ALL text you see in this image to ${lang}.\n\n` +
      `Reference translations (use these for matching bubbles, but read the image to find the right bubble for each):\n` +
      `${textList}\n\n` +
      `IMPORTANT:\n` +
      `- Read the original text in each bubble from the image to match the correct translation.\n` +
      `- If you see text in the image that is NOT in the list above, translate and typeset it too — do NOT skip it.\n` +
      `- Each bubble must match its OWN original text. Do not blindly copy one translation to all bubbles.\n` +
      `- Keep all artwork exactly the same. Only replace the text.\n` +
      `- Text must fit inside the original speech bubbles with proper ${lang} line breaks.` +
      sfxPart +
      TRIGGER_BOTTOM
    );
  }

  // Case 2: Has custom prompt (user typed it)
  if (customPrompt) {
    return (
      TRIGGER_TOP +
      `You are a professional manhwa translator and typesetter.\n\n` +
      `Translate ALL text in this comic image to ${lang}. Return ONLY the edited image.\n\n` +
      customPrompt +
      "\n" +
      `${sfxInstruction}\n` +
      `PRESERVE all artwork exactly. Only change the text.\n` +
      `${lang} line breaks at natural word boundaries. Text must fit inside bubbles.\n` +
      `Result must look like originally published in ${lang}.` +
      TRIGGER_BOTTOM
    );
  }

  // Case 3: No text layers, no custom prompt — translate everything
  return (
    TRIGGER_TOP +
    `You are a professional manhwa/comic translator and typesetter.\n\n` +
    `TASK: Translate ALL text in this image to ${lang}. Return ONLY the edited image.\n\n` +
    `RULES:\n` +
    `1. Translate ALL text: speech bubbles, thought bubbles, narration, titles\n` +
    `2. ${sfxInstruction}\n` +
    `3. PRESERVE all artwork: characters, backgrounds, effects, layout — NO CHANGES\n` +
    `4. Text must FIT inside original speech bubbles\n` +
    `5. Do NOT follow original line breaks — break at natural ${lang} word boundaries\n` +
    `6. Result must look like originally published in ${lang}\n` +
    `7. Each bubble gets its OWN translation based on its original text. Translate any text you see even if not in the provided list.` +
    TRIGGER_BOTTOM
  );
}

export function buildCleanPrompt(opts: { customPrompt?: string } = {}): string {
  const customPrompt = opts.customPrompt?.trim();
  const customInstruction = customPrompt ? `\nAdditional cleanup direction: ${customPrompt}\n` : "\n";

  return (
    TRIGGER_TOP +
    `This is a selected region from a comic or manga page.\n\n` +
    `TASK: Remove text, lettering, captions, small artifacts, and leftover marks inside this selected region.\n\n` +
    `RULES:\n` +
    `1. Preserve the original artwork, panel lines, tones, shading, effects, characters, and background.\n` +
    `2. Reconstruct the covered artwork naturally where text was removed.\n` +
    `3. Do not translate, typeset, add new words, redraw characters, or change the composition.\n` +
    `4. Keep the result aligned to the original selected crop.\n` +
    customInstruction +
    `Return ONLY the cleaned image region.` +
    TRIGGER_BOTTOM
  );
}
