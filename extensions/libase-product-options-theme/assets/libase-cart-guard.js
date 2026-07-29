(function () {
  "use strict";

  // カートページ以外では何もしない。app embed自体は全ページに配置されるが、
  // 実処理はカートページ読み込み時のみに限定する(最小変更・低リスクの実装方針)。
  if (!/\/cart\/?$/.test(window.location.pathname)) return;

  var reconciling = false;

  function fetchCart() {
    return fetch("/cart.js", { headers: { Accept: "application/json" } }).then(function (res) {
      return res.json();
    });
  }

  function changeLineQuantity(lineKey, quantity) {
    return fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: lineKey, quantity: quantity }),
    });
  }

  // メイン商品(_libase_group_idはあるが_libase_parentは無い行)に対して、
  // 同じgroup_idを持つ追加料金明細(_libase_parentがある行)を突き合わせる。
  // - メイン商品が無いgroup_idの追加料金明細は孤立とみなし削除する
  // - 数量が食い違っていればメイン商品の数量に合わせる
  async function reconcileCart() {
    if (reconciling) return;
    reconciling = true;
    try {
      var cart = await fetchCart();
      var mainByGroup = {};
      var addonsByGroup = {};

      cart.items.forEach(function (item) {
        var props = item.properties || {};
        var groupId = props._libase_group_id;
        if (!groupId) return;
        if (props._libase_parent) {
          addonsByGroup[groupId] = addonsByGroup[groupId] || [];
          addonsByGroup[groupId].push({ key: item.key, quantity: item.quantity });
        } else {
          mainByGroup[groupId] = { key: item.key, quantity: item.quantity };
        }
      });

      var groupIds = Object.keys(addonsByGroup);
      for (var g = 0; g < groupIds.length; g++) {
        var groupId = groupIds[g];
        var main = mainByGroup[groupId];
        var addonLines = addonsByGroup[groupId];
        for (var i = 0; i < addonLines.length; i++) {
          var addon = addonLines[i];
          if (!main) {
            // メイン商品が削除済み: 追加料金明細だけ残さない
            await changeLineQuantity(addon.key, 0);
          } else if (addon.quantity !== main.quantity) {
            // 数量変更時の整合性維持
            await changeLineQuantity(addon.key, main.quantity);
          }
        }
      }
    } catch (e) {
      // カート整合性チェックの失敗はページ動作をブロックしない。
    } finally {
      reconciling = false;
    }
  }

  var reconcileTimer = null;
  function scheduleReconcile() {
    // テーマのAJAXカート更新(DOM再描画)を検知するための単純なデバウンス。
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcileCart, 400);
  }

  reconcileCart();

  // fetchのグローバルラップは行わず、カートページのDOM変化を観測するだけに留める。
  // テーマのAJAXカート操作(数量変更・削除)は多くの場合カート内容のDOM再描画を伴うため、
  // それを検知して整合性チェックを再実行する。
  var observer = new MutationObserver(scheduleReconcile);
  observer.observe(document.body, { childList: true, subtree: true });
})();
