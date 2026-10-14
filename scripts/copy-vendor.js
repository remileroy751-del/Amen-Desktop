// Copie les bibliothèques (Supabase, jsPDF) dans renderer/vendor pour que
// l'application fonctionne avec des fichiers locaux (le CDN reste un secours).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });

const jobs = [
  {
    name: 'supabase.js',
    candidates: [
      'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
      'node_modules/@supabase/supabase-js/dist/umd/supabase.min.js'
    ]
  },
  {
    name: 'jspdf.umd.min.js',
    candidates: ['node_modules/jspdf/dist/jspdf.umd.min.js']
  }
];

for (const job of jobs) {
  const found = job.candidates.map(c => path.join(root, c)).find(p => fs.existsSync(p));
  if (found) {
    fs.copyFileSync(found, path.join(out, job.name));
    console.log('[vendor] OK  ->', job.name);
  } else {
    // Fichier vide : le chargement de secours depuis le CDN prendra le relais.
    fs.writeFileSync(path.join(out, job.name), '');
    console.warn('[vendor] ATTENTION : ' + job.name + ' introuvable, secours CDN utilisé.');
  }
}
