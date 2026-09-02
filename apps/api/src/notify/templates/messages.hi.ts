import type { MessageCatalogue } from "./messages.js";

/**
 * Hindi (India). A translation of the intent, not of the words: the same short,
 * editor-to-editor register as the English set, Devanagari throughout, and the
 * loanwords Indian editors actually use in the studio — "पासवर्ड", "अकाउंट",
 * "डिवाइस", "एक्सपोर्ट" — rather than Sanskritised coinages nobody says out loud.
 *
 * The variables and their names are identical to `messages.en.ts`, which is what
 * `templates.test.ts` checks: a placeholder that exists in one catalogue and not
 * the other is a message that throws at send time in exactly one language.
 */
export const HI_MESSAGES: MessageCatalogue = {
  locale: "hi-IN",

  chrome: {
    signoff: "{brand} की ओर से भेजा गया। कोई सवाल? इसी मेल का जवाब दें या {support} पर लिखें।",
    unsubscribe: "ये ईमेल बंद करें",
  },

  defaults: {
    name: "जी",
    device: "एक नया डिवाइस",
    location: "किसी अनजान जगह",
    hostApp: "none",
    project: "आपका प्रोजेक्ट",
    author: "किसी ने",
    plan: "आपका प्लान",
  },

  kinds: {
    "verify-email": {
      subject: "अपना ईमेल पता कन्फ़र्म करें",
      heading: "अपना ईमेल पता कन्फ़र्म करें",
      paragraphs: [
        "नमस्ते {name}, बस एक कदम बाकी है। इस पते को कन्फ़र्म कीजिए और आपका अकाउंट तैयार है।",
      ],
      cta: "ईमेल कन्फ़र्म करें",
      footnotes: [
        "यह लिंक एक ही बार चलता है और {hours, plural, one {# घंटे} other {# घंटों}} में ख़त्म हो जाता है।",
        "अगर आपने अकाउंट नहीं बनाया है तो इस मेल को छोड़ दीजिए — लिंक के बिना कुछ नहीं होता।",
      ],
    },

    "magic-link": {
      subject: "आपका साइन-इन लिंक",
      heading: "{brand} में साइन इन करें",
      paragraphs: ["नमस्ते {name}, यह रहा आपका साइन-इन लिंक। पासवर्ड की ज़रूरत नहीं।"],
      cta: "साइन इन करें",
      footnotes: [
        "यह लिंक एक ही बार चलता है और {minutes, plural, one {# मिनट} other {# मिनट}} में ख़त्म हो जाता है।",
        "अगर आपने साइन-इन नहीं माँगा था तो इसे छोड़ दीजिए और {support} पर लिखकर पासवर्ड बदल लीजिए।",
      ],
    },

    "password-changed": {
      subject: "आपका पासवर्ड बदल दिया गया",
      heading: "आपका पासवर्ड बदल दिया गया",
      paragraphs: [
        "नमस्ते {name}, अभी आपके अकाउंट का पासवर्ड बदला गया है। बाकी सभी डिवाइस साइन आउट कर दिए गए हैं।",
        "अगर यह आपने ही किया है तो कुछ करने की ज़रूरत नहीं।",
      ],
      cta: "अपने सेशन देखें",
      footnotes: [
        "अगर यह आपने नहीं किया, तो ऊपर के लिंक से पासवर्ड रीसेट कीजिए और तुरंत {support} पर लिखिए।",
      ],
    },

    "device-approval": {
      subject: "{device} को मंज़ूरी दें",
      heading: "नए डिवाइस को मंज़ूरी दें",
      paragraphs: [
        "नमस्ते {name}, {device} {brand} में{hostApp, select, none {} other { {hostApp} से}} साइन इन करना चाहता है।",
        "अनुरोध {location} से आया है। मंज़ूरी तभी दीजिए जब यह आपने शुरू किया हो।",
      ],
      cta: "इस डिवाइस को मंज़ूरी दें",
      footnotes: [
        "यह अनुरोध {minutes, plural, one {# मिनट} other {# मिनट}} में ख़त्म हो जाएगा।",
        "अगर यह आपने नहीं किया तो इस मेल को छोड़ दीजिए — डिवाइस बाहर ही रहेगा।",
      ],
    },

    "login-new-device": {
      subject: "{device} से नया साइन-इन",
      heading: "आपके अकाउंट में नया साइन-इन",
      paragraphs: [
        "नमस्ते {name}, आपके अकाउंट में {at} बजे {location} से {device} पर साइन इन हुआ है।",
        "अगर यह आप ही थे तो कुछ करने की ज़रूरत नहीं।",
      ],
      cta: "अपने सेशन देखें",
      footnotes: [
        "अगर यह आप नहीं थे, तो ऊपर के लिंक से उस सेशन को साइन आउट कीजिए और पासवर्ड बदल लीजिए।",
      ],
    },

    "parental-waitlist": {
      subject: "आप फ़ैमिली अकाउंट की वेटलिस्ट में हैं",
      heading: "आप वेटलिस्ट में हैं",
      paragraphs: [
        "धन्यवाद — फ़ैमिली अकाउंट शुरू होते ही हम इसी पते पर लिखेंगे, उससे पहले नहीं।",
        "तब तक माता-पिता या अभिभावक अपने अकाउंट का इस्तेमाल कर सकते हैं; बच्चे के लिए कोई अकाउंट नहीं बनाया गया है।",
      ],
      footnotes: ["एक पते पर एक ही मेल। लिस्ट से हटने के लिए इसी मेल का जवाब दे दीजिए।"],
    },

    "renewal-notice": {
      subject: "{plan} {renewsOn} को रिन्यू होगा — {amount}",
      heading: "आपका प्लान {days, plural, one {# दिन} other {# दिनों}} में रिन्यू होगा",
      paragraphs: [
        "नमस्ते {name}, आपका {plan} प्लान {renewsOn} को रिन्यू होगा और आपके सेव किए गए पेमेंट तरीके से {amount} काटे जाएँगे।",
        "उससे पहले आप प्लान बदल या बंद कर सकते हैं; बंद करना मौजूदा अवधि ख़त्म होने पर लागू होता है।",
      ],
      cta: "प्लान देखें",
      footnotes: [
        "यह वही प्री-डेबिट सूचना है जो आपका बैंक ज़रूरी करता है, इसलिए हर रिन्यूअल पर भेजी जाती है।",
      ],
    },

    "low-credits": {
      subject: "{minutes, plural, one {# मिनट} other {# मिनट}} प्रोसेसिंग बची है",
      heading: "आपके मिनट ख़त्म होने वाले हैं",
      paragraphs: [
        "नमस्ते {name}, आपके वर्कस्पेस में {minutes, plural, one {# मिनट} other {# मिनट}} क्लाउड प्रोसेसिंग बची है।",
        "अभी टॉप-अप कर लीजिए ताकि कतार में लगा कोई काम बीच में न रुके।",
      ],
      cta: "टॉप-अप करें",
      footnotes: ["लोकल और ब्राउज़र एक्सपोर्ट में प्रोसेसिंग मिनट कभी नहीं लगते।"],
    },

    "export-ready": {
      subject: "{project} डाउनलोड के लिए तैयार है",
      heading: "आपका एक्सपोर्ट तैयार है",
      paragraphs: [
        "नमस्ते {name}, {project} का रेंडर पूरा हो गया है और वह डाउनलोड के लिए तैयार है।",
      ],
      cta: "डाउनलोड करें",
      footnotes: [
        "फ़ाइल {days, plural, one {# दिन} other {# दिनों}} तक रखी जाती है, फिर हटा दी जाती है। प्रोजेक्ट से कभी भी दोबारा एक्सपोर्ट कर सकते हैं।",
      ],
    },

    "support-ticket-created": {
      subject: "[{category}] {subject}",
      heading: "नया सपोर्ट टिकट: {subject}",
      paragraphs: [
        'वर्कस्पेस {workspaceId} ने एक {category} टिकट दर्ज किया: "{subject}"।',
        "डायग्नोस्टिक्स: {diagnostics}।",
      ],
      cta: "एडमिन में खोलें",
      footnotes: ["टिकट आईडी {ticketId}।"],
    },

    "share-comment": {
      subject: "{project} पर {count, plural, one {# नया कमेंट} other {# नए कमेंट}}",
      heading: "{count, plural, one {# नया कमेंट} other {# नए कमेंट}}",
      paragraphs: [
        "नमस्ते {name}, {author} ने {project} पर {count, plural, one {एक कमेंट} other {# कमेंट}} किया है।",
      ],
      cta: "रिव्यू खोलें",
      footnotes: ["कमेंट एक साथ भेजे जाते हैं, ताकि व्यस्त रिव्यू से बीस मेल न आएँ।"],
    },

    "streak-nudge": {
      subject: "इस हफ़्ते अपनी स्ट्रीक बचाने के लिए एक एक्सपोर्ट बाकी है",
      heading: "इस हफ़्ते एक और एक्सपोर्ट चाहिए",
      paragraphs: [
        "नमस्ते {name}, आज मंगलवार है और इस हफ़्ते अभी तक {days, plural, one {# दिन} other {# दिन}} पब्लिश हुए हैं — तीन दिन से स्ट्रीक बनी रहती है।",
        "रविवार से पहले एक एक्सपोर्ट या अप्लाई करने से L{level} बना रहेगा।",
      ],
      cta: "ऐप खोलें",
      footnotes: [
        "फ्रीज़ अपने आप एक छूटा हफ़्ता बचा सकता है, पर असली एक्सपोर्ट से बेहतर कुछ नहीं।",
      ],
    },

    "retention-warning": {
      subject: "“{projectTitle}” {days, plural, one {# दिन} other {# दिन}} में डिलीट हो जाएगा",
      heading: "यह प्रोजेक्ट डिलीट होने वाला है",
      paragraphs: [
        "नमस्ते {name}, आपकी योजना में किसी प्रोजेक्ट का मीडिया एक तय समय तक ही रखा जाता है, और “{projectTitle}” की यह सीमा {retentionUntil} को पूरी हो रही है।",
        "इसे बचाने के लिए तारीख़ से पहले प्रोजेक्ट खोलें — कोई भी गतिविधि रिटेंशन विंडो को रीसेट कर देती है। तारीख़ के बाद इसका मीडिया स्थायी रूप से डिलीट हो जाएगा और वापस नहीं मिलेगा।",
      ],
      cta: "प्रोजेक्ट खोलें",
      footnotes: ["प्लान अपग्रेड करने से प्रोजेक्ट रखने की अवधि भी बढ़ जाती है।"],
    },

    "share-report-resolved": {
      subject: "शेयर की गई लिंक पर आपकी रिपोर्ट की समीक्षा हो गई है",
      heading: "आपकी रिपोर्ट की समीक्षा हो गई है",
      paragraphs: [
        "नमस्ते {name}, {reportedAt} को आपने जो रिपोर्ट दर्ज की थी, उसकी एडमिन ने समीक्षा कर ली है और शेयर की गई लिंक को {resolution} के रूप में चिह्नित किया है।",
        "{resolutionNote}",
      ],
      cta: "शेयरिंग के बारे में जानें",
      footnotes: ["यह मैसेज सिर्फ़ समीक्षा की पुष्टि है; आपकी ओर से कोई और कार्रवाई ज़रूरी नहीं है।"],
    },

    "support-ticket-reply": {
      subject: "आपके टिकट पर नया जवाब: {subject}",
      heading: "आपको एक जवाब मिला है",
      paragraphs: ["नमस्ते {name}, हमारी सपोर्ट टीम ने आपके टिकट पर जवाब दिया है:", "{replyBody}"],
      cta: "अपना टिकट देखें",
      footnotes: ["टिकट आईडी {ticketId}।"],
    },
  },
};
