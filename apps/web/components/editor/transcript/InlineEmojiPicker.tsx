"use client";

import React, { useEffect, useRef, useState } from "react";

export interface InlineEmojiPickerProps {
  readonly currentEmoji?: string;
  readonly onSelect: (emoji: string) => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}

const POPULAR_SHORTFORM_EMOJIS = [
  { emoji: "🔥", name: "fire" },
  { emoji: "💸", name: "money" },
  { emoji: "🚀", name: "rocket" },
  { emoji: "💀", name: "dead" },
  { emoji: "📈", name: "growth" },
  { emoji: "🤯", name: "mindblown" },
  { emoji: "⚠️", name: "warning" },
  { emoji: "🛑", name: "stop" },
  { emoji: "😭", name: "crying" },
  { emoji: "❤️", name: "heart" },
  { emoji: "😍", name: "hearteyes" },
  { emoji: "😂", name: "laugh" },
  { emoji: "🧠", name: "brain" },
  { emoji: "💡", name: "idea" },
  { emoji: "🎯", name: "target" },
  { emoji: "💪", name: "muscle" },
  { emoji: "👑", name: "crown" },
  { emoji: "🏆", name: "trophy" },
  { emoji: "🎉", name: "party" },
  { emoji: "👏", name: "clap" },
  { emoji: "👀", name: "eyes" },
  { emoji: "💯", name: "hundred" },
  { emoji: "💎", name: "gem" },
  { emoji: "🔒", name: "lock" },
  { emoji: "⏰", name: "clock" },
  { emoji: "⚡", name: "lightning" },
  { emoji: "⭐", name: "star" },
  { emoji: "✅", name: "check" },
  { emoji: "❌", name: "cross" },
  { emoji: "👍", name: "thumbsup" },
  { emoji: "😎", name: "cool" },
  { emoji: "💣", name: "bomb" },
];

export function InlineEmojiPicker({
  currentEmoji,
  onSelect,
  onRemove,
  onClose,
}: InlineEmojiPickerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }

    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const filtered = filter.trim()
    ? POPULAR_SHORTFORM_EMOJIS.filter((item) =>
        item.name.toLowerCase().includes(filter.toLowerCase()),
      )
    : POPULAR_SHORTFORM_EMOJIS;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Emoji Picker"
      data-testid="inline-emoji-picker"
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 rounded-xl border border-neutral-800 bg-neutral-900/95 p-2 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 pb-2 border-b border-neutral-800">
        <input
          type="text"
          placeholder="Search emoji..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="emoji-picker-search"
          className="flex-1 bg-neutral-800/80 rounded-md px-2 py-1 text-xs text-neutral-100 placeholder-neutral-500 outline-none focus:ring-1 focus:ring-accent"
          autoFocus
        />
        {onRemove && (
          <button
            type="button"
            data-testid="emoji-picker-remove"
            onClick={() => {
              onRemove();
              onClose();
            }}
            className="px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/10 rounded transition-colors"
          >
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-6 gap-1 pt-2 max-h-40 overflow-y-auto">
        {filtered.map((item) => (
          <button
            key={item.emoji}
            type="button"
            data-testid={`emoji-option-${item.emoji}`}
            data-active={currentEmoji === item.emoji ? "true" : undefined}
            onClick={() => {
              onSelect(item.emoji);
              onClose();
            }}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-neutral-800 transition-transform active:scale-95 ${
              currentEmoji === item.emoji ? "bg-accent/20 ring-1 ring-accent" : ""
            }`}
          >
            {item.emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
