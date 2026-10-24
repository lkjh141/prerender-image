// A small single-page app, the kind this image exists for: everything the crawler needs is built by JavaScript.
(function () {
  var root = document.getElementById('root');
  var LATE = /[?&]late=1/.test(location.search) || window.__LATE__;
  var READY_SIGNAL = /[?&]ready=1/.test(location.search);
  if (READY_SIGNAL) window.prerenderReady = false;

  function setMeta(name, content, attr) {
    var el = document.head.querySelector('meta[' + (attr || 'name') + '="' + name + '"]');
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr || 'name', name); document.head.appendChild(el); }
    el.setAttribute('content', content);
  }
  function setCanonical(path) {
    var el = document.head.querySelector('link[rel=canonical]');
    if (!el) { el = document.createElement('link'); el.rel = 'canonical'; document.head.appendChild(el); }
    el.href = location.origin + path;
  }
  function jsonLd(obj) {
    var el = document.createElement('script');
    el.type = 'application/ld+json';
    el.textContent = JSON.stringify(obj);
    document.head.appendChild(el);
  }
  function head(title, description, path) {
    document.title = title;
    setMeta('description', description);
    setMeta('og:title', title, 'property');
    setMeta('og:description', description, 'property');
    setMeta('og:type', 'website', 'property');
    setCanonical(path || location.pathname);
  }
  function nav() {
    return '<nav><a href="/">Home</a><a href="/products">Products</a><a href="/blog/stage-lighting-basics">Blog</a><a href="/about">About</a></nav>';
  }
  function api(path) { return fetch(path).then(function (r) { return r.json(); }); }
  function done() { if (READY_SIGNAL) window.prerenderReady = true; }

  var routes = [
    [/^\/$/, function () {
      head('Acme Stage Gear: lighting, sound and rigging for touring crews', 'Rent and buy touring stage gear: moving lights, line arrays, truss and rigging. Free quotes within one business day.', '/');
      root.innerHTML = nav() + '<h1>Stage gear for touring crews</h1><p>Moving lights, line arrays, truss and rigging, shipped to your venue.</p><p><a href="/products">Browse all products</a></p>';
      done();
    }],
    [/^\/products$/, function () {
      head('All products | Acme Stage Gear', 'Browse 12 products: moving lights, speakers, truss and rigging for touring productions.', '/products');
      root.innerHTML = nav() + '<h1>Products</h1><div id="list">Loading products…</div>';
      api('/api/products').then(function (items) {
        document.getElementById('list').innerHTML = items.map(function (p) {
          return '<div class="card"><h2><a href="/products/' + p.id + '">' + p.name + '</a></h2><p>' + p.summary + '</p><p>From $' + p.price + ' per day</p></div>';
        }).join('');
        done();
      });
    }],
    [/^\/products\/([\w-]+)$/, function (m) {
      root.innerHTML = nav() + '<div id="p">Loading…</div>';
      api('/api/products/' + m[1]).then(function (p) {
        if (!p || p.error) {
          head('Product not found | Acme Stage Gear', 'This product does not exist.', location.pathname);
          setMeta('prerender-status-code', '404');
          document.getElementById('p').innerHTML = '<h1>Product not found</h1><p>We could not find that product.</p>';
          done();
          return;
        }
        head(p.name + ' | Acme Stage Gear', p.summary, location.pathname);
        jsonLd({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.summary, offers: { '@type': 'Offer', priceCurrency: 'USD', price: p.price } });
        document.getElementById('p').innerHTML = '<h1>' + p.name + '</h1><p>' + p.summary + '</p><p>' + p.details + '</p><p>Price: $' + p.price + ' per day</p><p><a href="/products">All products</a></p>';
        done();
      });
    }],
    [/^\/blog\/([\w-]+)$/, function (m) {
      head('Stage lighting basics: a beginner\'s guide', 'How stage lighting works: fixtures, control, DMX and the first five things to learn.', location.pathname);
      root.innerHTML = nav() + '<article><h1>Stage lighting basics</h1><p>Every show starts with light. This guide explains fixtures, control and DMX in plain words.</p></article><section id="comments">Loading comments…</section>';
      // Comments arrive late, like a third-party widget would: this is what separates a short wait from a long one.
      setTimeout(function () {
        api('/api/comments').then(function (c) {
          document.getElementById('comments').innerHTML = '<h2>Comments</h2>' + c.map(function (x) { return '<p><strong>' + x.who + '</strong>: ' + x.text + '</p>'; }).join('');
          done();
        });
      }, LATE ? 900 : 300);
    }],
    [/^\/about$/, function () {
      head('About Acme Stage Gear', 'Acme has supplied touring productions since 1998 from three warehouses.', '/about');
      root.innerHTML = nav() + '<h1>About us</h1><p>Founded in 1998, we supply touring productions from three warehouses in Europe and North America.</p>';
      done();
    }],
  ];

  function render() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    for (var i = 0; i < routes.length; i++) { var m = routes[i][0].exec(path); if (m) { routes[i][1](m); return; } }
    head('Page not found | Acme Stage Gear', 'The page you asked for does not exist.', path);
    setMeta('prerender-status-code', '404');
    root.innerHTML = nav() + '<h1>Page not found</h1><p>Nothing lives at this address.</p>';
    done();
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (a && a.origin === location.origin && !e.defaultPrevented) { e.preventDefault(); history.pushState({}, '', a.pathname); render(); }
  });
  window.addEventListener('popstate', render);
  render();
})();
