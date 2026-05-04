// server.js — Backend Radar ML
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── CONFIG ──────────────────────────────────────────────────────────────────
const ML_APP_ID    = process.env.ML_APP_ID;
const ML_SECRET    = process.env.ML_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const SITE_ID      = 'MLB'; // Brasil

let tokens = { access_token: '', refresh_token: '', user_id: '' };

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_APP_ID}&redirect_uri=${REDIRECT_URI}`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'authorization_code',
      client_id:     ML_APP_ID,
      client_secret: ML_SECRET,
      code,
      redirect_uri:  REDIRECT_URI
    });
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.user_id       = data.user_id;
    console.log('✅ Autenticado! User ID:', tokens.user_id);
    res.send('<h2>✅ Autenticado com sucesso! Pode fechar esta aba e usar o Radar ML.</h2>');
  } catch (err) {
    console.error('Erro auth:', err.response?.data || err.message);
    res.status(500).send('Erro na autenticação: ' + JSON.stringify(err.response?.data));
  }
});

// Refresh automático do token
async function refreshToken() {
  if (!tokens.refresh_token) return;
  try {
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'refresh_token',
      client_id:     ML_APP_ID,
      client_secret: ML_SECRET,
      refresh_token: tokens.refresh_token
    });
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token;
    console.log('🔄 Token renovado com sucesso');
  } catch (err) {
    console.error('Erro refresh token:', err.response?.data || err.message);
  }
}
// Renova token a cada 5h (expira em 6h)
setInterval(refreshToken, 5 * 60 * 60 * 1000);

// Helper de headers
const authHeader = () => ({ Authorization: `Bearer ${tokens.access_token}` });

// ── SEARCH ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 20, sort = 'sold_quantity_desc' } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });

  try {
    // 1. Busca na API pública (não precisa de token)
    const searchUrl =
      `https://api.mercadolibre.com/sites/${SITE_ID}/search` +
      `?q=${encodeURIComponent(q)}&limit=${limit}&sort=${sort}`;

    const { data: searchData } = await axios.get(searchUrl);
    const results = searchData.results || [];

    // 2. Para cada produto, busca dados extras em paralelo
    const enriched = await Promise.allSettled(
      results.map(item => enrichItem(item))
    );

    const finalResults = enriched.map((r, i) =>
      r.status === 'fulfilled' ? r.value : results[i]
    );

    res.json({
      total:   searchData.paging?.total || 0,
      results: finalResults,
      query:   q,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Erro search:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enriquece cada item com dados extras
async function enrichItem(item) {
  try {
    // Dados extras do item (inclui sold_quantity, reviews, etc.)
    const [itemDetail, visits] = await Promise.allSettled([
      axios.get(`https://api.mercadolibre.com/items/${item.id}`),
      tokens.access_token
        ? axios.get(`https://api.mercadolibre.com/items/visits?ids=${item.id}`,
            { headers: authHeader() })
        : Promise.resolve({ data: {} })
    ]);

    const detail = itemDetail.status === 'fulfilled' ? itemDetail.value.data : {};
    const visitData = visits.status === 'fulfilled' ? visits.value.data : {};

    return {
      ...item,
      sold_quantity:     detail.sold_quantity || item.sold_quantity || 0,
      available_quantity: detail.available_quantity || 0,
      condition:         detail.condition || item.condition,
      catalog_product_id: detail.catalog_product_id || item.catalog_product_id || null,
      reviews:           detail.reviews || { rating_average: 0, total: 0 },
      visits:            visitData[item.id]?.total_visits || 0,
      listing_type_id:   detail.listing_type_id,
      health:            detail.health,
      tags:              detail.tags || [],
    };
  } catch {
    return item;
  }
}

// ── CATALOG CHECK ─────────────────────────────────────────────────────────────
app.get('/api/catalog/:productId', async (req, res) => {
  try {
    const { data } = await axios.get(
      `https://api.mercadolibre.com/products/${req.params.productId}`
    );
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Catálogo não encontrado', detail: err.response?.data });
  }
});

// ── STATUS ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!tokens.access_token,
    user_id:       tokens.user_id || null,
    timestamp:     new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Radar ML Backend rodando em http://localhost:${PORT}`);
  console.log(`🔐 Para autenticar: http://localhost:${PORT}/auth\n`);
});
