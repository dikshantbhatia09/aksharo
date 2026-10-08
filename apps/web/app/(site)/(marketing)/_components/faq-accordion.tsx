"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

const FAQS: readonly FaqItem[] = [
  {
    question: "How does Aksharo turn long videos into viral shorts?",
    answer:
      "Aksharo uses multimodal AI to analyze speech, audio dynamics, and facial cues in your video. Our TRIBE neuro-attention model scores engagement and emotional hooks, extracts the top 10 moments, reframes subjects to 9:16 vertical video using YuNet face tracking, and adds synchronized dynamic karaoke captions.",
  },
  {
    question: "What types of videos and links can I paste?",
    answer:
      "You can drop links from YouTube, Google Drive, Zoom cloud recordings, Vimeo, StreamYard, and Loom. You can also upload local video and audio files including MP4, MOV, MKV, WebM, MP3, and WAV up to 10 GB.",
  },
  {
    question: "Which languages and accents does Aksharo support?",
    answer:
      "Aksharo is specifically optimized for conversational English, Hindi, and Hinglish (mixed Hindi-English), as well as regional Indian accents. We support Devanagari and Latin script transcription with phoneme-level word alignment.",
  },
  {
    question: "Is there a watermark on the free plan?",
    answer:
      "Your first export is completely free with zero watermark! You can experience full 1080x1920 HD quality and all premium caption styles without entering a credit card.",
  },
  {
    question: "Can I customize the caption fonts, colors, and animations?",
    answer:
      "Yes! You can choose from over 30 viral kinetic typography presets (Punch Pop, Hormozi, Neon, Devanagari, Beast), adjust font weights, active word highlight colors, stroke width, text position, and auto-emoji insertions.",
  },
  {
    question: "Can I export subtitles (SRT, VTT, ASS) for my video editing software?",
    answer:
      "Yes. In addition to high-speed NVENC rendered MP4 video exports, Aksharo provides instant subtitle downloads in SRT, VTT, and styled ASS formats that import directly into any video editing timeline.",
  },
];

export function FaqAccordion(): React.JSX.Element {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (index: number): void => {
    setOpenIndex((prev) => (prev === index ? null : index));
  };

  return (
    <section className="relative mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Heading */}
      <div className="flex flex-col items-center text-center">
        <h2 className="text-fg-0 text-3xl font-bold tracking-tight sm:text-5xl">
          Got questions?
        </h2>
        <p className="text-fg-1 mt-4 text-base sm:text-lg">
          Everything you need to know about Aksharo&apos;s AI video repurposing workflow.
        </p>
      </div>

      {/* Accordion List */}
      <div className="mt-12 space-y-4">
        {FAQS.map((faq, index) => {
          const isOpen = openIndex === index;
          return (
            <div
              key={faq.question}
              className="overflow-hidden rounded-2xl border border-white/10 bg-[#14121a]/90 backdrop-blur-xl transition-all duration-200 hover:border-white/20"
            >
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between p-6 text-left"
              >
                <span className="text-fg-0 text-base font-semibold sm:text-lg">
                  {faq.question}
                </span>
                <ChevronDown
                  className={cn(
                    "size-5 shrink-0 text-fg-2 transition-transform duration-200",
                    isOpen && "rotate-180 text-fg-0",
                  )}
                />
              </button>

              {isOpen && (
                <div className="border-t border-white/8 px-6 pt-3 pb-6 text-fg-1 text-sm sm:text-base leading-relaxed">
                  {faq.answer}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

