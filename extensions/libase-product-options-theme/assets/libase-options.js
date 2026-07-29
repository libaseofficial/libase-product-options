(function () {
  "use strict";

  // === 有料オプション(追加料金variant)関連の修正まとめ ===
  // 1. フォーム誤登録: 「Shop Pay Installments」等の分割払い案内フォームも
  //    input[name="id"] を持つため、それだけでは本物の商品フォームと区別できず
  //    誤って登録されることがあった。送信ボタンの有無も条件に加えて解決
  //    (hasSubmitControl / isRealProductForm)。
  // 2. GID未変換: 追加料金variantのIDがGraphQL GID形式のまま /cart/add.js に
  //    送信され、数値IDのみを受け付ける同APIで解決に失敗していた。
  //    toNumericVariantId() で数値部分のみを抽出して送信するよう修正。
  // 3. テーマ標準UI未更新: 有料オプション込みの追加は独自fetchで /cart/add.js を
  //    叩くため、テーマ標準の product-form.js が実行されず、カート追加通知
  //    (cart-notification)とヘッダーのカート件数バッジが更新されなかった。
  //    UIを自前で再実装せず、Section Rendering API 経由で取得した sections を
  //    テーマ自身の cart-notification.renderContents() に渡して更新を任せる。

  function logError() {
    var args = ["[libase-options]"].concat(Array.prototype.slice.call(arguments));
    if (window.console && window.console.error) {
      window.console.error.apply(window.console, args);
    }
  }

  function logWarn() {
    var args = ["[libase-options]"].concat(Array.prototype.slice.call(arguments));
    if (window.console && window.console.warn) {
      window.console.warn.apply(window.console, args);
    }
  }

  var blocks = [];
  var isSubmittingAddons = false;

  function collectFieldValue(fieldEl) {
    var type = fieldEl.getAttribute("data-libase-type");
    if (type === "checkbox") {
      var checked = fieldEl.querySelectorAll("[data-libase-checkbox-input]:checked");
      var labels = [];
      for (var i = 0; i < checked.length; i++) {
        labels.push(checked[i].value);
      }
      return labels.join(", ");
    }
    // dropdownが画像付きカード(radio)で描画されている場合、data-libase-input を
    // 持つ要素が複数存在するため、単純な querySelector では未選択の1件目を
    // 拾ってしまう。checkedなものを明示的に探す。
    var radios = fieldEl.querySelectorAll('input[type="radio"][data-libase-input]');
    if (radios.length > 0) {
      for (var r = 0; r < radios.length; r++) {
        if (radios[r].checked) return radios[r].value;
      }
      return "";
    }
    var input = fieldEl.querySelector("[data-libase-input]");
    return input ? input.value : "";
  }

  // 選択中の選択肢のうち、追加料金variantが紐付けられているものを集める。
  // (dropdown/checkboxのどちらも、画像カード版/通常版の両方に対応)
  function collectSelectedAddons(fieldEl) {
    var type = fieldEl.getAttribute("data-libase-type");
    var addons = [];

    function addFromElement(el) {
      var variantId = el.getAttribute("data-libase-variant-id");
      if (!variantId) return;
      addons.push({
        variantId: variantId,
        optionKey: el.getAttribute("data-libase-option-key") || fieldEl.getAttribute("data-libase-label") || "",
      });
    }

    if (type === "checkbox") {
      var checkedBoxes = fieldEl.querySelectorAll("[data-libase-checkbox-input]:checked");
      checkedBoxes.forEach(addFromElement);
      return addons;
    }

    var radios = fieldEl.querySelectorAll('input[type="radio"][data-libase-input]');
    if (radios.length > 0) {
      var checkedRadio = null;
      radios.forEach(function (radio) {
        if (radio.checked) checkedRadio = radio;
      });
      if (checkedRadio) addFromElement(checkedRadio);
      return addons;
    }

    var select = fieldEl.querySelector("select[data-libase-input]");
    if (select && select.selectedOptions && select.selectedOptions[0]) {
      addFromElement(select.selectedOptions[0]);
    }
    return addons;
  }

  function collectAddonsForEntries(entries) {
    var addons = [];
    entries.forEach(function (entry) {
      entry.fieldEls.forEach(function (fieldEl) {
        addons = addons.concat(collectSelectedAddons(fieldEl));
      });
    });
    return addons;
  }

  function isFieldValid(fieldEl) {
    if (fieldEl.getAttribute("data-libase-required") !== "true") return true;
    var value = collectFieldValue(fieldEl);
    return value.trim().length > 0;
  }

  // チェックボックス群には native required を直接付けられないため、
  // 「1つ以上選択済みか」を非表示の代理checkboxに反映し、ブラウザ標準の
  // フォームバリデーション(独自JSのsubmit/clickイベント捕捉に依存しない経路)でも
  // 必須チェックが効くようにする。
  function syncCheckboxProxy(fieldEl) {
    var proxy = fieldEl.querySelector("[data-libase-checkbox-required-proxy]");
    if (!proxy) return;
    proxy.checked = fieldEl.querySelectorAll("[data-libase-checkbox-input]:checked").length > 0;
  }

  function setFieldError(fieldEl, message) {
    fieldEl.classList.toggle("libase-options__field--invalid", !!message);
    var errorEl = fieldEl.querySelector(".libase-options__error");
    if (!message) {
      if (errorEl) errorEl.remove();
      return;
    }
    if (!errorEl) {
      errorEl = document.createElement("p");
      errorEl.className = "libase-options__error";
      fieldEl.appendChild(errorEl);
    }
    errorEl.textContent = message;
  }

  function showBlockMessage(blockEl, message, isError) {
    var el = blockEl.querySelector(".libase-options__cart-message");
    if (!el) {
      el = document.createElement("p");
      el.className = "libase-options__cart-message";
      blockEl.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle("libase-options__cart-message--error", !!isError);
  }

  // 本物の商品フォームには必ずvariantを表すid入力(input または select)が存在する。
  function hasVariantIdInput(form) {
    return !!form.querySelector('input[name="id"], select[name="id"]');
  }

  // 「Shop Pay Installments」等の分割払い案内フォームは、価格計算のために
  // input[name="id"] を持つことがあり id 入力の有無だけでは本物の商品フォームと
  // 区別できない(実機検証済み)。この案内フォームは購入者が実際に送信するもの
  // ではないため送信コントロール(送信ボタン)を持たない。これを本物の商品フォーム
  // の判定基準に使う。
  function hasSubmitControl(form) {
    return !!form.querySelector('button[name="add"], button[type="submit"], input[type="submit"]');
  }

  function isRealProductForm(form) {
    return hasVariantIdInput(form) && hasSubmitControl(form);
  }

  function findTargetForm(blockEl) {
    var closestForm = blockEl.closest('form[action*="/cart/add"]');
    if (closestForm && isRealProductForm(closestForm)) {
      return closestForm;
    }

    // アプリブロックが商品フォームの外に配置された場合のフォールバック。
    // 同じセクション内に複数の /cart/add フォームがある場合は、
    // 「送信ボタンとid入力の両方を持つ本物の商品フォーム」を優先して選ぶ。
    var scope = blockEl.closest(".shopify-section") || document;
    var scopedCandidates = scope.querySelectorAll('form[action*="/cart/add"]');
    for (var i = 0; i < scopedCandidates.length; i++) {
      if (isRealProductForm(scopedCandidates[i])) {
        return scopedCandidates[i];
      }
    }

    var globalCandidates = document.querySelectorAll('form[action*="/cart/add"]');
    for (var j = 0; j < globalCandidates.length; j++) {
      if (isRealProductForm(globalCandidates[j])) {
        return globalCandidates[j];
      }
    }

    // 送信ボタン+id入力の両方を持つフォームがどこにも見つからない場合のみ、
    // 従来の優先順位(直近の祖先 → 同じセクション内の最初のフォーム → ページ内最初のフォーム)
    // にフォールバックする。
    if (closestForm) return closestForm;
    if (scopedCandidates.length > 0) return scopedCandidates[0];
    return globalCandidates[0] || null;
  }

  function entriesForForm(form) {
    return blocks.filter(function (entry) {
      return entry.form === form;
    });
  }

  function validateEntries(entries) {
    var firstInvalid = null;
    entries.forEach(function (entry) {
      entry.fieldEls.forEach(function (fieldEl) {
        if (!isFieldValid(fieldEl)) {
          var label = fieldEl.getAttribute("data-libase-label");
          setFieldError(fieldEl, label + "は必須項目です。");
          if (!firstInvalid) firstInvalid = fieldEl;
        }
      });
    });
    return firstInvalid;
  }

  function blockSubmission(event, firstInvalid) {
    event.preventDefault();
    event.stopImmediatePropagation();
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // テーマ標準のカート更新通知。特定テーマの内部実装には依存せず、
  // よく使われる慣習的なイベント名をベストエフォートで発火するに留める。
  function notifyCartUpdated() {
    ["cart:refresh", "cart:updated", "cart:build", "cart-update"].forEach(function (name) {
      try {
        document.dispatchEvent(new CustomEvent(name, { bubbles: true }));
      } catch (e) {
        // 古いブラウザ等でCustomEventが使えない場合は無視する。
      }
    });
  }

  function readFormProperties(formData) {
    var properties = {};
    formData.forEach(function (value, key) {
      var match = key.match(/^properties\[(.+)\]$/);
      if (match) properties[match[1]] = value;
    });
    return properties;
  }

  function generateGroupId() {
    return (
      "libase-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // data-libase-variant-id は DB の linkedVariantId(GraphQL GID形式、
  // 例: "gid://shopify/ProductVariant/123") をそのまま出力しているが、
  // /cart/add.js の items[].id は数値のバリアントIDのみ受け付ける。
  // GIDのままだとバリアントを解決できずリクエスト全体が失敗するため、ここで変換する。
  function toNumericVariantId(rawId) {
    var match = String(rawId).match(/(\d+)\s*$/);
    if (!match) {
      logWarn("想定外のvariant ID形式のため数値IDへ変換できませんでした。", "rawId=" + rawId);
      return rawId;
    }
    return match[1];
  }

  // 有料オプションを含む追加は独自fetchで /cart/add.js を叩くため、テーマ標準の
  // product-form.js のsubmitハンドラが実行されず、テーマの「カートに追加しました」
  // 通知(cart-notification)とヘッダーのカート件数バッジ(cart-icon-bubble)が
  // 更新されない。これらはDawn系テーマ(Rise含む)が標準で持つSection Rendering API
  // 連携なので、UIを自前で再実装せず、/cart/add.js のレスポンスに含まれる
  // sections HTMLをテーマ自身の cart-notification 要素の renderContents() に渡して
  // 更新を任せる。要素が存在しないテーマではfeature detectionで何もしない。
  var THEME_NOTIFICATION_SECTION_IDS = [
    "cart-notification-product",
    "cart-notification-button",
    "cart-icon-bubble",
  ];

  function updateThemeCartUI(mainItemKey, sections) {
    if (!sections) return;
    var notification = document.querySelector("cart-notification");
    if (!notification || typeof notification.renderContents !== "function") return;
    try {
      notification.renderContents({ key: mainItemKey, sections: sections });
    } catch (e) {
      logError("cart-notification.renderContents() の呼び出しに失敗しました。", String(e));
    }
  }

  // 有料オプション(追加料金variant)が選択されている場合のみ、メイン商品と
  // 追加料金variantを /cart/add.js へ items 配列でまとめて1リクエストで追加する。
  // 無料オプションのみの場合はこの関数を呼ばず、テーマ標準の送信に任せる。
  function submitWithAddons(entries, form, addons) {
    if (isSubmittingAddons) return;
    isSubmittingAddons = true;

    var formData = new FormData(form);
    var mainVariantId = formData.get("id");
    var quantity = parseInt(formData.get("quantity"), 10) || 1;
    var groupId = generateGroupId();

    var mainProperties = readFormProperties(formData);
    mainProperties["_libase_group_id"] = groupId;

    var items = [{ id: mainVariantId, quantity: quantity, properties: mainProperties }];
    addons.forEach(function (addon) {
      items.push({
        id: toNumericVariantId(addon.variantId),
        quantity: quantity,
        properties: {
          _libase_parent: String(mainVariantId),
          _libase_option_key: addon.optionKey,
          _libase_group_id: groupId,
        },
      });
    });

    var blockEls = entries.map(function (entry) {
      return entry.blockEl;
    });

    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: items,
        sections: THEME_NOTIFICATION_SECTION_IDS.join(","),
        sections_url: window.location.pathname,
      }),
    })
      .then(function (response) {
        return response.text().then(function (bodyText) {
          var json = null;
          try {
            json = JSON.parse(bodyText);
          } catch (e) {
            // ok=false時にbodyTextがJSONでない場合、下のログにそのまま出力する。
          }
          if (!response.ok) {
            logError(
              "/cart/add.js への追加に失敗しました。",
              "status=" + response.status,
              "body=" + bodyText,
            );
          }
          return { ok: response.ok, json: json };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var message = (result.json && result.json.description) || "カートへの追加に失敗しました。";
          blockEls.forEach(function (blockEl) {
            showBlockMessage(blockEl, message, true);
          });
          return;
        }
        notifyCartUpdated();
        blockEls.forEach(function (blockEl) {
          showBlockMessage(blockEl, "カートに追加しました。追加料金を含む合計はカートでご確認ください。", false);
        });

        var addedItems = (result.json && result.json.items) || [];
        var mainItem = addedItems.filter(function (item) {
          return String(item.id) === String(mainVariantId);
        })[0];
        if (mainItem) {
          updateThemeCartUI(mainItem.key, result.json.sections);
        }
      })
      .catch(function () {
        blockEls.forEach(function (blockEl) {
          showBlockMessage(blockEl, "通信エラーのためカートに追加できませんでした。もう一度お試しください。", true);
        });
      })
      .finally(function () {
        isSubmittingAddons = false;
      });
  }

  function handleFormSubmission(event, form) {
    var entries = entriesForForm(form);
    if (entries.length === 0) {
      return;
    }

    var firstInvalid = validateEntries(entries);
    if (firstInvalid) {
      blockSubmission(event, firstInvalid);
      return;
    }

    var addons = collectAddonsForEntries(entries);
    if (addons.length === 0) {
      return; // 無料オプションのみ: 従来どおりメイン商品のみ追加させる
    }

    // 有料オプションが絡む場合は、メイン商品と追加料金variantを1リクエストで
    // まとめて追加する必要があるため、標準の送信をここで止めて自前のfetchに切り替える。
    event.preventDefault();
    event.stopImmediatePropagation();
    submitWithAddons(entries, form, addons);
  }

  // Shopify標準のカート追加ボタンは .shopify-payment-button というクラス名で
  // 描画される(テーマ非依存)。有料オプションを含む商品では、この動的チェックアウト
  // ボタンから購入されると追加料金が反映されないため、非表示にする。
  // ボタンはShopify側のJSが非同期で挿入するため、MutationObserverで監視する。
  function disableDynamicCheckout(form) {
    var scope = form.closest(".shopify-section") || form.parentElement || document.body;

    function hideButtons() {
      scope.querySelectorAll(".shopify-payment-button").forEach(function (el) {
        if (el.dataset.libaseHidden === "true") return;
        el.dataset.libaseHidden = "true";
        el.style.display = "none";
      });
    }

    hideButtons();
    var observer = new MutationObserver(hideButtons);
    observer.observe(scope, { childList: true, subtree: true });
  }

  function setupBlock(blockEl) {
    if (blockEl.dataset.libaseInitialized === "true") return;
    blockEl.dataset.libaseInitialized = "true";

    var form = findTargetForm(blockEl);
    if (!form) {
      return;
    }

    var fieldEls = blockEl.querySelectorAll("[data-libase-field]");
    blocks.push({ form: form, fieldEls: fieldEls, blockEl: blockEl });

    fieldEls.forEach(function (fieldEl) {
      if (fieldEl.getAttribute("data-libase-type") === "checkbox") {
        syncCheckboxProxy(fieldEl);
      }
      fieldEl.addEventListener("input", function () {
        if (isFieldValid(fieldEl)) setFieldError(fieldEl, "");
      });
      fieldEl.addEventListener("change", function () {
        if (fieldEl.getAttribute("data-libase-type") === "checkbox") {
          syncCheckboxProxy(fieldEl);
        }
        if (isFieldValid(fieldEl)) setFieldError(fieldEl, "");
      });
    });

    if (blockEl.dataset.libaseHasPaidOptions === "true") {
      disableDynamicCheckout(form);
    }
  }

  // line item properties の注入。
  // new FormData(form) はテーマ側の実装(通常のsubmitでも独自fetchでの手動生成でも)に
  // 関わらず必ず formdata イベントを発火するため、bubbleフェーズの監視だけで確実に動く。
  // (有料オプションを含む送信は preventDefault 済みで別経路のため、ここでは重複しない)
  document.addEventListener("formdata", function (event) {
    entriesForForm(event.target).forEach(function (entry) {
      entry.fieldEls.forEach(function (fieldEl) {
        var label = fieldEl.getAttribute("data-libase-label");
        var value = collectFieldValue(fieldEl);
        if (value) {
          event.formData.set("properties[" + label + "]", value);
        }
      });
    });
  });

  // 必須項目チェック・有料オプションの多明細追加(submitイベント)。
  // 多くのテーマはカート追加ボタンのフォームに独自の submit リスナーを付けてAjax送信する。
  // フォーム要素に後から addEventListener しても、テーマ側のリスナーが先に登録されていた場合は
  // 登録順で後回しになり、こちらで preventDefault() した時にはテーマ側のfetchが既に走ってしまう。
  // document の capture フェーズで先取りすれば、登録順に関係なく必ずテーマ側より先に検証できる。
  document.addEventListener(
    "submit",
    function (event) {
      handleFormSubmission(event, event.target);
    },
    true,
  );

  // テーマによっては送信ボタンのclickハンドラ内でnative submitを介さずAjax送信するため、
  // その場合は submit イベント自体が発火しない。clickの捕捉フェーズでも同様に検証する。
  // button要素はtype属性を省略してもDOMプロパティ上は"submit"がデフォルトになるため、
  // 属性セレクタ(button[type="submit"])ではなく .type プロパティで判定する。
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var control = target.closest("button, input, [name='add']");
      if (!control) return;
      var controlType = ("type" in control ? control.type : "") || "";
      var isSubmitControl =
        control.getAttribute("name") === "add" ||
        (control.tagName === "BUTTON" && controlType.toLowerCase() === "submit") ||
        (control.tagName === "INPUT" &&
          (controlType.toLowerCase() === "submit" || controlType.toLowerCase() === "image"));
      if (!isSubmitControl) return;
      var form = control.form || control.closest("form");
      if (!form) return;
      handleFormSubmission(event, form);
    },
    true,
  );

  function init() {
    var blockEls = document.querySelectorAll("[data-libase-block-id]");
    blockEls.forEach(setupBlock);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
