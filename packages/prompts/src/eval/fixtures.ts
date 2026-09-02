/**
 * Fixture transcripts the eval runner scores every template against (brief
 * §1: "fixture transcripts (Hinglish, Hindi, English, Tamil)"). Short and
 * hand-written on purpose — the eval is about the template/schema/guard
 * machinery, not about corpus coverage.
 */
import type { PromptTranscriptInput } from "../templates/types.js";

export interface Fixture {
  readonly id: string;
  readonly transcript: PromptTranscriptInput;
}

function segmentsFrom(
  sentences: readonly string[],
  msPerSentence = 4_000,
): PromptTranscriptInput["segments"] {
  return sentences.map((text, i) => ({
    startMs: i * msPerSentence,
    endMs: (i + 1) * msPerSentence,
    text,
    speaker: "spk0",
  }));
}

const english: PromptTranscriptInput = {
  language: "en",
  mediaTitle: "How I Edit My Videos",
  durationMs: 40_000,
  segments: segmentsFrom([
    "Hey everyone welcome back to the channel today we are talking about video editing",
    "First let's set up the timeline and import all our footage",
    "Now I want to show you my favourite transition technique",
    "Colour grading is the next step and it makes a huge difference",
    "Finally we export the video and upload it to YouTube",
    "Thanks for watching and see you in the next one",
    "Do not forget to check the description for the tools I used",
    "Editing takes practice so keep experimenting with your own style",
    "If you enjoyed this video please like and subscribe",
    "That is all for today take care everyone",
  ]),
};

const hindi: PromptTranscriptInput = {
  language: "hi",
  mediaTitle: "मेरी वीडियो एडिटिंग टिप्स",
  durationMs: 32_000,
  segments: segmentsFrom([
    "नमस्ते दोस्तों आज हम वीडियो एडिटिंग के बारे में बात करेंगे",
    "सबसे पहले टाइमलाइन सेट करते हैं",
    "अब मैं आपको अपनी पसंदीदा ट्रांजिशन तकनीक दिखाता हूँ",
    "कलर ग्रेडिंग अगला कदम है",
    "अंत में हम वीडियो एक्सपोर्ट करते हैं",
    "देखने के लिए धन्यवाद फिर मिलेंगे",
    "विवरण में उपकरण की सूची जरूर देखें",
    "अभ्यास करते रहें",
  ]),
};

const hinglish: PromptTranscriptInput = {
  language: "hi-Latn",
  mediaTitle: "Video Editing Tips Yaar",
  durationMs: 32_000,
  segments: segmentsFrom([
    "Hey dosto aaj hum baat karenge video editing ke baare mein",
    "Sabse pehle timeline set karte hain aur footage import karte hain",
    "Ab main aapko apni favourite transition technique dikhata hoon",
    "Colour grading agla step hai aur bahut fark padta hai",
    "Finally hum video export karte hain aur YouTube pe upload karte hain",
    "Dekhne ke liye thanks phir milenge next video mein",
    "Description mein tools ki list zaroor dekho",
    "Practice karte raho apna style develop karne ke liye",
  ]),
};

const tamil: PromptTranscriptInput = {
  language: "ta",
  mediaTitle: "எனது வீடியோ எடிட்டிங் குறிப்புகள்",
  durationMs: 28_000,
  segments: segmentsFrom([
    "வணக்கம் நண்பர்களே இன்று நாம் வீடியோ எடிட்டிங் பற்றி பேசுவோம்",
    "முதலில் டைம்லைனை அமைப்போம்",
    "இப்போது எனக்கு பிடித்த ட்ரான்சிஷன் நுட்பத்தை காண்பிக்கிறேன்",
    "கலர் கிரேடிங் அடுத்த படி",
    "இறுதியாக வீடியோவை ஏற்றுமதி செய்கிறோம்",
    "பார்த்ததற்கு நன்றி மீண்டும் சந்திப்போம்",
    "விளக்கத்தில் உள்ள கருவிகளை பாருங்கள்",
  ]),
};

export const FIXTURES: readonly Fixture[] = [
  { id: "english", transcript: english },
  { id: "hindi", transcript: hindi },
  { id: "hinglish", transcript: hinglish },
  { id: "tamil", transcript: tamil },
];
