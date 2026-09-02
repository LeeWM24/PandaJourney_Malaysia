const SENSITIVE_WORDS = [
    // Strong English profanity
  "fuck",
  "fucker",
  "fucking",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "bastard",
  "asshole",
  "dumbass",
  "jackass",
  "dickhead",
  "cunt",
  "pussy",
  "slut",
  "whore",

  // English insults
  "idiot",
  "moron",
  "imbecile",
  "retard",
  "retarded",
  "loser",
  "scumbag",
  "worthless",
  "pathetic",
  "shut up",
  "go to hell",
  "fuck off",

  // Threatening or harmful phrases
  "kill yourself",
  "go kill yourself",
  "kys",
  "i will kill you",
  "i'll kill you",
  "you should die",
  "go die",
  "drop dead",

  // Malay / Manglish profanity
  "bodoh",
  "bangang",
  "bengap",
  "tolol",
  "sial",
  "celaka",
  "pukimak",
  "puki mak",
  "lancau",
  "lanjiao",
  "kimak",
  "kepala hotak",
  "otak udang",
  "kurang ajar",
  "tak guna",
  "pergi mampus",
  "mampus",
  "mati lah",
  "pergi mati",

  "白痴",
  "笨蛋",
  "废物","妈的",
  "他妈的",
  "操你妈",
  "草你妈",
  "去死",
  "滚蛋",
  "王八蛋",
  "神经病"
];

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\W_]+/gu, "");
}


export function findSensitiveWord(text) {
  const normalizedText = normalizeText(text);

  for (const word of SENSITIVE_WORDS) {
    const normalizedWord = normalizeText(word);

    if (
      normalizedWord &&
      normalizedText.includes(normalizedWord)
    ) {
      return word;
    }
  }

  return null;
}

export function validateContent(text) {
  const detectedWord = findSensitiveWord(text);

  if (detectedWord) {
    return {
      isValid: false,
      message:
        "Your comment contains inappropriate language. " +
        "Please revise it before submitting."
    };
  }

  return {
    isValid: true,
    message: ""
  };
}