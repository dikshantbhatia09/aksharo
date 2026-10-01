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
    video: "आपका वीडियो",
    clip: "आपकी क्लिप",
    first: "no",
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
      footnotes: ["ब्राउज़र एक्सपोर्ट में प्रोसेसिंग मिनट कभी नहीं लगते।"],
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
      footnotes: [
        "यह मैसेज सिर्फ़ समीक्षा की पुष्टि है; आपकी ओर से कोई और कार्रवाई ज़रूरी नहीं है।",
      ],
    },

    "support-ticket-reply": {
      subject: "आपके टिकट पर नया जवाब: {subject}",
      heading: "आपको एक जवाब मिला है",
      paragraphs: ["नमस्ते {name}, हमारी सपोर्ट टीम ने आपके टिकट पर जवाब दिया है:", "{replyBody}"],
      cta: "अपना टिकट देखें",
      footnotes: ["टिकट आईडी {ticketId}।"],
    },

    "clips-ready": {
      subject:
        "{first, select, yes {आपकी पहली क्लिप तैयार हैं: {video}} other {{video} की आपकी पहली क्लिप तैयार हैं}}",
      heading: "{first, select, yes {आपकी पहली क्लिप तैयार हैं} other {आपकी क्लिप तैयार हैं}}",
      paragraphs: [
        "नमस्ते {name}, {video} की {count, plural, one {# क्लिप} other {# क्लिप}} देखने के लिए तैयार {count, plural, one {है} other {हैं}}।",
        "{first, select, yes {हर क्लिप बोलने वाले पर फ़्रेम की गई है, उस पर कैप्शन हैं और उसका स्कोर है। रन खोलकर सबसे अच्छी क्लिप पहले देखें: किसी को भी एडिटर में खोलकर उसके शब्द या लुक बदलें, सबको एक साथ डाउनलोड करें, या अपने मेहमान के साथ शेयर करें। जो क्लिप अभी बन रही हैं, वे बनते ही वहीं दिखेंगी।} other {रन खोलकर उन्हें देखें, एडिट करें या डाउनलोड करें। जो क्लिप अभी बन रही हैं, वे बनते ही वहीं दिखेंगी।}}",
      ],
      cta: "अपनी क्लिप खोलें",
      footnotes: ["यह मेल हर वीडियो के लिए एक ही बार आता है।"],
      push: {
        title: "{first, select, yes {आपकी पहली क्लिप तैयार हैं} other {आपकी क्लिप तैयार हैं}}",
        body: "{video} की {count, plural, one {# क्लिप} other {# क्लिप}} देखने के लिए तैयार।",
      },
    },

    "run-complete": {
      subject: "सब तैयार: {video} की {count, plural, one {# क्लिप} other {# क्लिप}}",
      heading: "सब कुछ तैयार है",
      paragraphs: [
        "नमस्ते {name}, {video} का काम पूरा हो गया: {count, plural, one {# क्लिप} other {# क्लिप}}, उनके साइज़ और इमेज के साथ।",
        "रन से उन्हें डाउनलोड करें, या किसी को भी बदलने के लिए एडिटर में खोलें।",
      ],
      cta: "अपनी क्लिप खोलें",
      push: {
        title: "सब कुछ तैयार है",
        body: "{video} की {count, plural, one {# क्लिप} other {# क्लिप}}, उनके साइज़ और इमेज के साथ।",
      },
    },

    "run-failed": {
      subject: "हम {video} पूरा नहीं कर पाए",
      heading: "यह वीडियो रुक गया",
      paragraphs: [
        "नमस्ते {name}, हम {video} पूरा नहीं कर पाए। जो कुछ बन चुका है, वह सुरक्षित है।",
        "क्या हुआ और आगे क्या करें, यह देखने के लिए रन खोलें।",
      ],
      cta: "रन खोलें",
      push: {
        title: "एक वीडियो रुक गया",
        body: "हम {video} पूरा नहीं कर पाए। वजह देखने के लिए खोलें।",
      },
    },

    "run-needs-you": {
      subject:
        "{reason, select, credits {{video} पूरा करने के लिए क्रेडिट जोड़ें} upload {{video} की फ़ाइल अपलोड करें} add {{video} आपके मोमेंट्स के लिए तैयार है} other {{video} के मोमेंट्स तैयार हैं}}",
      heading:
        "{reason, select, credits {आपके क्रेडिट ख़त्म हो गए} upload {YouTube यह वीडियो नहीं दे रहा} add {अपने मोमेंट्स जोड़ें} other {अपने मोमेंट्स चुनें}}",
      paragraphs: [
        "नमस्ते {name}, {reason, select, credits {{video} के लिए इस वर्कस्पेस में बचे क्रेडिट काफ़ी नहीं हैं। क्रेडिट जोड़ें, फिर रन से दोबारा कोशिश करें।} upload {YouTube हमें {video} भेजने से बार-बार मना कर रहा है। फ़ाइल अपने डिवाइस से अपलोड करें, रन उसी से आगे बढ़ेगा।} add {{video} तैयार है। जिन मोमेंट्स की क्लिप चाहिए, उन्हें उनके शुरू और ख़त्म होने के समय से जोड़ें।} other {{video} के मोमेंट्स तैयार हैं। जिनकी क्लिप चाहिए, उन्हें चुनें।}}",
      ],
      cta: "रन खोलें",
      push: {
        title:
          "{reason, select, credits {क्रेडिट ख़त्म} upload {फ़ाइल अपलोड करें} add {अपने मोमेंट्स जोड़ें} other {आपके मोमेंट्स तैयार हैं}}",
        body: "{reason, select, credits {{video} पूरा करने के लिए क्रेडिट जोड़ें।} upload {YouTube {video} नहीं दे रहा। इसे अपने डिवाइस से अपलोड करें।} add {{video} से जिन मोमेंट्स की क्लिप चाहिए, उन्हें जोड़ें।} other {{video} से अपने मोमेंट्स चुनें।}}",
      },
    },

    "watch-new-video": {
      subject: "{channel} का नया वीडियो: क्लिप बन रही हैं",
      heading: "नया एपिसोड मिला",
      paragraphs: [
        "नमस्ते {name}, {channel} ने {video} पब्लिश किया है। आपकी चुनी सेटिंग के साथ, ऑटोपायलट पर इसकी क्लिप बन रही हैं।",
        "इसे देखने के लिए रन खोलें। पहली क्लिप तैयार होते ही हम बताएँगे।",
      ],
      cta: "रन खोलें",
      footnotes: [
        "यह मेल इसलिए आया क्योंकि {channel} आपके वर्कस्पेस से जुड़ा है। रोकने के लिए ऑटोमेशन में इसे पॉज़ करें।",
      ],
    },

    "watch-paused": {
      subject:
        "{reason, select, credits {क्रेडिट जोड़ें: {channel} रुका हुआ है} style {{channel} रुका हुआ है: कैप्शन लुक चुनें} setup {{channel} रुका हुआ है: सेटिंग देखें} other {{channel} नहीं मिला}}",
      heading:
        "{reason, select, credits {आपके क्रेडिट ख़त्म हो गए} style {इसका कैप्शन लुक अब नहीं है} setup {इसकी सेटिंग देखनी होगी} other {चैनल नहीं मिला}}",
      paragraphs: [
        "नमस्ते {name}, {reason, select, credits {{channel} का ऑटोमेशन क्रेडिट ख़त्म होने पर अपने-आप रुक गया। क्रेडिट जोड़ें, फिर इसे दोबारा चालू करें: जो वीडियो शुरू नहीं हो पाया था, वह सबसे पहले लिया जाएगा।} style {{channel} का ऑटोमेशन रुक गया, क्योंकि इसका कैप्शन लुक अब उपलब्ध नहीं है। इसकी सेटिंग में दूसरा लुक चुनें, फिर इसे दोबारा चालू करें।} setup {{channel} का ऑटोमेशन रुक गया, क्योंकि इसकी सेटिंग अब मान्य नहीं है। सेटिंग फिर से सेव करें, फिर इसे दोबारा चालू करें।} other {हमें YouTube पर {channel} नहीं मिला, इसलिए इसका ऑटोमेशन रुक गया। अगर चैनल वापस आ गया है, तो इसे दोबारा चालू करें।}}",
      ],
      cta: "ऑटोमेशन खोलें",
      push: {
        title:
          "{reason, select, credits {ऑटोमेशन रुका: क्रेडिट ख़त्म} style {ऑटोमेशन रुका} setup {ऑटोमेशन रुका} other {चैनल नहीं मिला}}",
        body: "{reason, select, credits {क्रेडिट जोड़ें, फिर {channel} को दोबारा चालू करें।} style {{channel} के लिए कैप्शन लुक चुनें, फिर इसे दोबारा चालू करें।} setup {{channel} की सेटिंग देखें, फिर इसे दोबारा चालू करें।} other {हमें YouTube पर {channel} नहीं मिला।}}",
      },
    },

    "clip-review": {
      subject:
        "{verdict, select, approved {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने {video} की एक क्लिप अप्रूव की} changes {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने {video} की एक क्लिप में बदलाव माँगे} reopened {{video} की एक क्लिप को फिर से रिव्यू चाहिए} other {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने {video} की एक क्लिप पर कमेंट किया}}",
      heading:
        "{verdict, select, approved {क्लिप अप्रूव हो गई} changes {बदलाव माँगे गए} reopened {फिर से रिव्यू के लिए} other {नया कमेंट}}",
      paragraphs: [
        "नमस्ते {name}, {verdict, select, approved {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” अप्रूव की।} changes {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” में बदलाव माँगे।} reopened {रिव्यू के बाद “{clip}” बदल गई, इसलिए यह फिर से रिव्यू का इंतज़ार कर रही है।} other {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” पर कमेंट किया।}}",
        "{verdict, select, approved {जो अप्रूव हुआ, वही पोस्ट होगा: क्लिप एडिट होने पर वह फिर से रिव्यू में आ जाएगी।} changes {उन्होंने क्या माँगा है, यह पढ़ने के लिए रन खोलें।} reopened {नया वर्ज़न देखें, फिर उसे अप्रूव करें या बदलाव माँगें।} other {इसे पढ़ने के लिए रन खोलें।}}",
      ],
      cta: "रन खोलें",
      push: {
        title:
          "{verdict, select, approved {क्लिप अप्रूव हो गई} changes {बदलाव माँगे गए} reopened {फिर से रिव्यू चाहिए} other {नया कमेंट}}",
        body: "{verdict, select, approved {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” अप्रूव की।} changes {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” में बदलाव माँगे।} reopened {“{clip}” बदल गई, इसे फिर से रिव्यू चाहिए।} other {{by, select, client {{who} (क्लाइंट)} guest {आपके क्लाइंट} other {{who}}} ने “{clip}” पर कमेंट किया।}}",
      },
    },
  },
};
