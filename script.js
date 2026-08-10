(function () {
  var storageKey = "drguilherme_attribution_v2";
  var trackedKeys = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "wbraid",
    "gbraid",
    "gad_source"
  ];
  var passthroughKeys = ["gclid", "wbraid", "gbraid", "gad_source"];
  var storedUtmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
  var currentParams = new URLSearchParams(window.location.search);
  var attribution = {};
  var pageType = document.body.dataset.pageType || "teleconsulta_landing";
  var pageVariant = document.body.dataset.pageVariant || "premium_identity_doctoralia_v1";
  var leadValue = Number(document.body.dataset.leadValue || 70);

  document.documentElement.classList.add("reveal-ready");

  trackedKeys.forEach(function (key) {
    var value = currentParams.get(key);
    if (value) attribution[key] = value;
  });

  try {
    if (window.__drAnalyticsConsent === "granted" && Object.keys(attribution).length > 0) {
      window.localStorage.setItem(storageKey, JSON.stringify(attribution));
    } else if (window.__drAnalyticsConsent === "granted") {
      attribution = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    }
  } catch (error) {
    attribution = attribution || {};
  }

  window.__drAttribution = attribution;
  function trackEvent(eventName, payload) {
    if (window.__drAnalyticsConsent !== "granted" || typeof window.gtag !== "function") return;
    window.gtag("event", eventName, payload);
  }

  function trackLandingContext() {
    trackEvent("landing_context", {
      page_type: pageType,
      page_variant: pageVariant,
      landing_path: getLandingPath()
    });
  }

  function getLandingPath() {
    if (window.location.protocol === "file:") return "/";
    return window.location.pathname || "/";
  }

  function decorateHref(rawHref) {
    var url = new URL(rawHref, window.location.origin);

    if (window.__drAnalyticsConsent !== "granted") return url.toString();

    passthroughKeys.forEach(function (key) {
      if (attribution[key]) url.searchParams.set(key, attribution[key]);
    });

    storedUtmKeys.forEach(function (key) {
      if (attribution[key]) url.searchParams.set("landing_" + key, attribution[key]);
    });

    url.searchParams.set("landing_page", getLandingPath());
    return url.toString();
  }

  function makeEventId(location) {
    return ["drg", location || "cta", Date.now(), Math.random().toString(36).slice(2, 10)].join("_");
  }

  function buildLeadPayload(link, eventId) {
    return {
      page_type: pageType,
      page_variant: pageVariant,
      lead_type: "doctoralia_schedule_click",
      conversion_action: "doctoralia_schedule_click",
      event_id: eventId,
      value: leadValue,
      currency: "BRL",
      cta_location: link.dataset.ctaLocation || "unknown",
      landing_path: getLandingPath()
    };
  }

  function prepareDoctoraliaLink(link) {
    var baseHref = link.getAttribute("href");
    if (!baseHref) return;

    link.setAttribute("data-base-href", baseHref);
    link.setAttribute("href", decorateHref(baseHref));
  }

  var doctoraliaSelector = 'a[data-doctoralia-link="true"]';
  document.querySelectorAll(doctoraliaSelector).forEach(prepareDoctoraliaLink);

  if (window.__drAnalyticsReady) {
    trackLandingContext();
  } else {
    document.addEventListener("drg:analytics-ready", trackLandingContext, { once: true });
  }

  document.addEventListener("drg:consent-change", function () {
    if (window.__drAnalyticsConsent !== "granted") {
      document.querySelectorAll(doctoraliaSelector).forEach(function (link) {
        var baseHref = link.getAttribute("data-base-href");
        if (baseHref) link.setAttribute("href", baseHref);
      });
      return;
    }

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(attribution));
    } catch (error) {
      // A atribuição segue disponível apenas durante esta visita.
    }

    document.querySelectorAll(doctoraliaSelector).forEach(prepareDoctoraliaLink);
  });

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest(doctoraliaSelector) : null;
    if (!link) return;

    var finalHref = decorateHref(link.getAttribute("data-base-href") || link.href);
    var leadPayload = buildLeadPayload(link, makeEventId(link.dataset.ctaLocation));

    link.setAttribute("href", finalHref);
    trackEvent("doctoralia_click", leadPayload);
    trackEvent("generate_lead", leadPayload);
  });

  var revealItems = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  if (!("IntersectionObserver" in window)) {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.16 }
  );

  revealItems.forEach(function (item) {
    observer.observe(item);
  });

  var hero = document.querySelector(".hero");
  if (hero) {
    var stickyObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          document.documentElement.classList.toggle("show-mobile-cta", !entry.isIntersecting);
        });
      },
      { threshold: 0.08 }
    );
    stickyObserver.observe(hero);
  }
})();
