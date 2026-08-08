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
    if (Object.keys(attribution).length > 0) {
      window.localStorage.setItem(storageKey, JSON.stringify(attribution));
    } else {
      attribution = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    }
  } catch (error) {
    attribution = attribution || {};
  }

  window.__drAttribution = attribution;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: "landing_context",
    page_type: pageType,
    page_variant: pageVariant,
    landing_url: getLandingUrl(),
    landing_path: getLandingPath(),
    lead_value: leadValue,
    currency: "BRL",
    attribution_utm_source: attribution.utm_source || "",
    attribution_utm_medium: attribution.utm_medium || "",
    attribution_utm_campaign: attribution.utm_campaign || "",
    attribution_utm_term: attribution.utm_term || "",
    attribution_utm_content: attribution.utm_content || "",
    attribution_utm_id: attribution.utm_id || "",
    attribution_gclid: attribution.gclid || "",
    attribution_wbraid: attribution.wbraid || "",
    attribution_gbraid: attribution.gbraid || "",
    attribution_gad_source: attribution.gad_source || ""
  });

  function getLandingPath() {
    if (window.location.protocol === "file:") return "/";
    return window.location.pathname || "/";
  }

  function getLandingUrl() {
    if (window.location.protocol === "file:") return "https://drrampinelli.com.br/";
    return window.location.href;
  }

  function decorateHref(rawHref) {
    var url = new URL(rawHref, window.location.origin);

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

  function buildLeadPayload(link, finalHref, eventId) {
    var linkText = (link.textContent || "").trim();

    return {
      page_type: pageType,
      page_variant: pageVariant,
      lead_type: "doctoralia_schedule_click",
      conversion_action: "doctoralia_schedule_click",
      event_id: eventId,
      value: leadValue,
      currency: "BRL",
      cta_location: link.dataset.ctaLocation || "unknown",
      cta_text: linkText,
      destination_url: finalHref,
      link_url: finalHref,
      link_text: linkText,
      landing_url: getLandingUrl(),
      landing_path: getLandingPath(),
      attribution_utm_source: attribution.utm_source || "",
      attribution_utm_medium: attribution.utm_medium || "",
      attribution_utm_campaign: attribution.utm_campaign || "",
      attribution_utm_term: attribution.utm_term || "",
      attribution_utm_content: attribution.utm_content || "",
      attribution_utm_id: attribution.utm_id || "",
      attribution_gclid: attribution.gclid || "",
      attribution_wbraid: attribution.wbraid || "",
      attribution_gbraid: attribution.gbraid || "",
      attribution_gad_source: attribution.gad_source || ""
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

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest(doctoraliaSelector) : null;
    if (!link) return;

    var finalHref = decorateHref(link.getAttribute("data-base-href") || link.href);
    var leadPayload = buildLeadPayload(link, finalHref, makeEventId(link.dataset.ctaLocation));

    link.setAttribute("href", finalHref);
    window.dataLayer.push(Object.assign({ event: "doctoralia_click" }, leadPayload));
    window.dataLayer.push(Object.assign({ event: "generate_lead" }, leadPayload));
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
