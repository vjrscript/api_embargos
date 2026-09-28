/*******************************************************************************
 * MONITORAMENTO DE EMBARGOS DE GOIÁS — SEMAD/GO
 * Versão revisada (sugestões de melhoria sobre o script original)
 *
 * Autor original: Vicente de Paula Sousa Júnior | Analista Ambiental
 * Revisão técnica: refatoração para eliminar duplicação de código,
 *   corrigir comportamento da interface, padronizar nomenclatura
 *   (EVI x NDVI), validar entradas do usuário e atualizar o método
 *   de mascaramento de nuvens do Sentinel-2.
 *
 * IMPORTANTE: ajuste a variável "table" abaixo para o Asset real da
 * sua tabela de embargos antes de rodar (no script original ela
 * chegava pronta via "Imports" do Code Editor e não aparecia no corpo
 * do código).
 ******************************************************************************/

// var table = ee.FeatureCollection('projects/SEU_PROJETO/assets/embargos_go');

/* ============================== 1. CONFIGURAÇÃO ============================== */
// Todos os "números mágicos" do script original agora vivem aqui, em um único
// lugar. Trocar o período analisado, a paleta ou o limiar de nuvem passa a ser
// uma alteração de uma linha, em vez de caçar o valor espalhado pelo código.

var STUDY_CENTER = {lon: -49.25389, lat: -16.67861, zoom: 14};

// Intervalo de anos das composições Sentinel-2 / EVI
var START_YEAR = 2018;
var END_YEAR = 2026;

// Intervalo de anos disponível no Mapbiomas Coleção 2 (10 m) usado no script original
var MAPBIOMAS_START_YEAR = 2016;
var MAPBIOMAS_END_YEAR = 2023;

// Limiares de nuvem: um mosaico "bonito" para visualização tolera menos nuvem
// do que uma série temporal, que precisa preservar o máximo de observações
// mensais possível. No script original esses dois usos (10% e 20%) já eram
// diferentes, mas não havia nenhum comentário explicando a escolha — o que
// parece um "número mágico" e não uma decisão. Agora isso é explícito.
var CLOUD_THRESHOLD_COMPOSITE = 10;   // % de nuvem na cena, para os mosaicos anuais (RGB/EVI)
var CLOUD_THRESHOLD_TIMESERIES = 20;  // % de nuvem na cena, para os gráficos de série temporal

var EVI_PALETTE = ['ff003b', 'fc7770', 'd6f044', '8fdd27', '78c679', '41ab5d', '238443'];
var EVI_VIS = {min: 0, max: 1, palette: EVI_PALETTE};

var CLOUD_SCORE_THRESHOLD = 0.60; // 0.50–0.65 costuma funcionar bem; ajuste por região

/* ---- Realce (contraste) das imagens RGB ----
 * O script original usava min:0 / max:0.3 fixo para todas as áreas e todos os
 * anos. Esse valor é um compromisso: em alvo escuro (mata densa, água) a cena
 * fica "lavada"; em alvo claro (solo exposto, areia, telhado) fica estourada.
 * Daí o contraste às vezes sair ruim.
 *
 * A solução é um realce por percentis: mede-se o histograma real da SUA área
 * e joga-se o percentil baixo para o preto e o alto para o branco, banda a
 * banda (o que também corrige a dominante de cor).
 *
 * DECISÃO IMPORTANTE: o realce é calculado UMA única vez, sobre a mediana de
 * todos os anos, e o MESMO min/max é aplicado a todos os anos. Se cada ano
 * recebesse o próprio realce, o contraste se adaptaria à cena e uma supressão
 * de vegetação apareceria com brilho parecido antes e depois — exatamente a
 * mudança que o monitoramento de embargo precisa enxergar. Realce
 * compartilhado = anos comparáveis entre si.
 */
var STRETCH_PRESETS = {
  'Suave (5-95%)': [5, 95],
  'Padrão (2-98%)': [2, 98],
  'Forte (1-99%)': [1, 99],
  'Fixo 0-0.3 (original)': null
};
var DEFAULT_STRETCH = 'Padrão (2-98%)';
var RGB_GAMMA = 1.2;        // >1 clareia os tons médios sem estourar as altas luzes
var STRETCH_SCALE = 20;     // resolução (m) do cálculo do histograma — 20 m é rápido e suficiente

// EVI: por padrão fica na escala absoluta 0–1, porque os limiares descritos no
// painel de interpretação (0.2 / 0.5 / 0.8) só fazem sentido nessa escala.
// O realce relativo fica disponível como opção, e nesse caso a legenda é
// reescrita com os valores realmente usados.
var EVI_STRETCH_PERCENTILES = [2, 98];

/* ---- Relatório ---- */
var REPORT_THUMB_SIZE = 260;   // px de cada miniatura na grade do relatório
var REPORT_ANIM_SIZE = 420;    // px da animação/filmstrip
var REPORT_ANIM_FPS = 1;       // quadros por segundo da animação temporal
var EXPORT_SCALE = 10;         // resolução (m) das exportações GeoTIFF
var EXPORT_FOLDER = 'GEE_Relatorios_Embargos'; // pasta no Google Drive

// Classes temáticas do Mapbiomas e cores associadas (Coleção 8 / classification8)
var MAPBIOMAS_CLASSES = {
  0: 'Não observado',
  1: 'Formação Florestal',
  2: 'Formação Savânica',
  3: 'Campo Alagado/Pântano',
  4: 'Formação Campestre',
  5: 'Pastagem',
  6: 'Lavoura Temporária',
  7: 'Cana',
  8: 'Mosaico de Usos',
  9: 'Área Urbanizada',
  10: 'Área não Vegetada',
  11: 'Mineração',
  12: "Rios e Corpos D'água",
  13: 'Lavoura Perene'
};

var MAPBIOMAS_COLORS = {
  0: '#ffffff',
  1: '#1f8d49',
  2: '#7dc975',
  3: '#519799',
  4: '#d6bc74',
  5: '#edde8e',
  6: '#C27BA0',
  7: '#db7093',
  8: '#ffefc3',
  9: '#d4271e',
  10: '#db4d4f',
  11: '#9c0027',
  12: '#2532e4',
  13: '#d082de'
};

// Logo em base64 definido uma única vez (no original ele existia duas vezes,
// duplicando ~30 KB de texto no script). Um widget ui.Chart não pode ser
// reaproveitado em dois painéis diferentes, então a função buildLogoPanel()
// abaixo cria uma nova instância a partir desta mesma string sempre que
// precisar de um logo — sem duplicar o conteúdo.
var LOGO_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAOMAAABxCAYAAAFQJySSAABFRElEQVR4nO1dB1wTSxMfSEJCb1IFBBQLooAKCiIiIooF7L0gioC9PZ/t8z27z67YC/aCvRfsCtJEUVRs9KrSO4HAd3PxYgIBggZs/PPLb/f2tt7c3M7uzs7Sy8vLob5Br/cSxVGo6oB95TRJCdJfVlYOrO67SP/clhngaZDDi8dqmiYhtkKpAhGShP+DUyzpb3ZdH9a/UeHdS5z6NU2VhXI4HBqbzZYqKS1hKMgr5FQV7+rKvtBn0RXS/+nsBNDZtpMsmCocq1Txramy0Izi7EZ7XhydA1+SLuo0bZ6weG0YrSF+LddfFPU3RPcGMLymT17H9omB0jIJuPVJBvo1FaFQZSmF9EdJIT1uDDpqXlUcBD5GflCtbH2zCehfNeCF97MSoVAajcbhL7DvJdfQK84HLSrGox4jYlSIZqVKCEOVhUpISPBIMf364iPCCkTwF2Kshn5uJZ5NuA47w47CnvBj1RdqsLMTu2/LHmduxNzvLyctl1tWypFUZCpkssvZrLZHHdNejPZrJKzgxKlPIDglBDpqWRIvUgcyzOW0G8TnpJD3qDChhcZ4BUmRnm7CW18VzHx6QLjbLTJzqpCozARg0IQ/SLF8kdIKMnmtoVyqwIqtFFuhtcV3F0o8TomaY4m50G8Bvb67tnpv5XcVePLuu/Lp2x8JhEl120m6/F8ofIbSX7q07yoQCysjSPJ893BY6/sUTtx7TxbUhPjOVvwEUt2Z0AJvRz/qa65kHKiqopqO1+kZ6aqUvyKkGTQw9/TlXWNBcURvUhWEFrjz5ZF57dRNghZ1mk52XbveHfub8vMjfu3fldJigfgvKQOi4FheWJUtzM3NlT/rvMfW49rfp6kwYYVRGfGDRvQF/BKCsJ6lUoHy8vK56LJKGfndjg95fW/kaWNhhSEUGRwIc0io1LrqIFBgel5mI1U55bSJ1+aev5n6sP9xR2+HnqdHPbs55JjQjjq7hAZShp/gZqwfKDGVQIbxF/xt7Qq5xYWwPuggyDKkYbHNZFhwb0PlApc+3rTpc1GGRrui5g/29V4/4HnkCzOvkH/OF5YUypjtd/wYPsFPQ1ihetsteb0GugjqA/7W4xGY7u8uvIX/WM+aRfk/ZX7WMG3VNvxxq/MGUAOivR5DMadYoNDLQ/aDuYYpNN9tA+88/AV6EKFvqbqy2seaCqJguNNa4Lpi91Rtp1wf+K4Cf4kuqt67px+BH9Lx1zd+aCPVB+0vxzHaFz8vnD8Mu/UBOrmwro1gHyklWQ4293QgNp8BnRoVwXHLVDKcfwRL4YdT8lVMGnSbe5H0zxxoCpvPPScbl3xqPLhYG8ATVimcT5Qn/xQSnaOhqEQS7nZNEsjLgBhXpkyrXEatGkl8I8uxr8Q+E6+tpE1vBxY+d0B/9KTHTMN9nYvJSkwOFflrRDUQgQ2koD30ACSsmwfl5V+zYtHKQOeKIehcMhSaF62KUkVq5N7w47PczUZuoj6l6O5/dXLGhNbDt/DHq03jEPgqRveOJQRBwfDn2VIw6LE2NL32tbNsJseGG12SBaRRUSFSI7GBFcMqNvBbgBXGBiIFjsfLg55sCVirFIGpIlugMcODNeFJBkukCQD+CR4KP5QnRam0OPDDPzwIThkHUqY/48lF2He3VG0GyfnJ0FXPCj7lZ0JI8jNe/IiJN2FT6AG4H/cI7JpYQnRWCuEPqjL/WjWyrLxMMjotzqiZmsFb/vCEzCR9XeXGsehPzfmkramgnlybfI+6bMK8eddJ08J4Dd7Vkzs1R12jhNpyjy3ksQtIv7Z3O5CUkKw2/1o1ssmujpwHg043X3Br1Y7l9vOmS4BE+YCL7v4buvxvPBWntg1EjLs8l6wwJddrbTUnKYvwDtsL09q7k3687359NgSOOw8rA7aRYcnTnsLA8+MhJCmiyvxr1cgEL+7Xc3WPhZOpsEsDfayqTiE6+EV4miRN4Pq/wN0Cca5HPSTdk68vi5T3D+VJ754rRk+79b+j2PXo7rQoX2Q9fd4qf+818VNCaK0P2GfmFOQqJkwJldTZ3qE8ccoTiRZ7bXPfuj+U3xl+eJ6+vM6H4NRntv92njMT89LZYVFuoKD7Xlg5P7SRA4x6HcM/+qm3xNN0zDp0X42/q0zFwwaiiw1E18tsLMmoTk3tz/HiVNNHN4xCfhc0NFJcwGUyXMupj7KEoV4auejOmm1rHBd58YepD/IpxwlfTWUZSM0sqDItNU2MwK9HVDUCeosb+hA3pfJ8zA9/XV/sGwGNBuwjV1Up4KDZYe4FeBHDHSgLG3lseKcM+2IUgEkMnl84xhESkwS87VU5HuKHNxIHyPwNpMIoUA2MKWBAjweNK6UvKZMAQ74h2U83CuGf5lBTZMErn1G8BuIiPTa+4khFVYoDwd0TKmYFLEZZlYNpkRtJ9KcSxcXFzPyCfFlcY2cwGCUV72dmZSqrKKtkiJrnsVuRMNKhFen/nF3EayA2/nZYPIxcdYu8ViAa8NQhvlJ6iv7IqzgdUtWAWuRG6m63KKPT6aUE6DgzgFMhGI5+w11Wxc9G31THBmblZispyStm1ZTfjZlboNfmcpi163Gle9jY3CIWZG4VXFxpfqMJyXtVAQfgyd8zx7O73Yr+fax7XVwZtHXtlXe3hlBTIXgd7RnILOWU0v8L2rHy706TF4mSn0njJKErRBXRN0Ab3uRICYSNM8iB/7X8+sLQiZpoXTEgP0LCIFIjN/vtWjjT0XMV+iuuMD1PeU0ODeg0eqmoDUQYEryWXyIBKf0E19jwG6R5yQBk6IIVxq6jKgG0lLiRUNu1uoqY7jBpDbpFxUUsFpNVhJ17UmaKrl4jndiY1Lim5od6puYU5ylFut5TkJKSYouSJ0KWaIiwKRCqgS97xgHrC3XKv/yNqpkyeUl0JSwh4SI1UlJSkhy2YwPRRekFG4j+EM9r+vxKIqIi2unrLF1oJhOi8hgwqHE+MIS8cqLOBZn4NYHE5pXDv6kLQUranh70Pj432SBuQhBt+OUptzU+ycf8M/Tv+QX5BTK6WjqVP4UVgK9rLNFQfNUslIvJPwUWrRx0rtS4dicyvqmRSMmA4Rd4nZKv8w7e2qOqgorwREKg/0WTqq4htJGfM9LU1FQafaaubU8Mepua86nxO49Hcnhtss8+/eXEu6rU/UEXJz0867LHNj8/X1aCJlkuw5KuWhitBoosWZBjyICb6SBY7r8LDjivghk3VwHB7+T8TpPtlsApL4Mn4y9DhwP94Hj/9TDt5nJIL8yufSP5G4h4OOJsC/5r/gYisIHoysrK5n9L4xDWOmbw4lMkRGclkQ1EjL+0UCBOyPgroCGjzpvrGXlhrkh5V/m63n71wCmGk9QyKjHaKDA3vHu7RiaBS63nzFCQlicfW0JKot6JkHPj57lMX/ptzRLEqf77SBcbMKBFD/DusRry2DnQco+9gALZbqfVvDQVV+2rQpWNdGjd9TrhXIe2wu/jx0VcDayoBYcNpLQAWqs144Uv7OwJfZr2IHwLyHvLAtbDnmcna8xf5A/Px08fNTTUNUgtgh5Hh4ffGn3SDP1t9nVPU2EqfX4w5mwrkVtVBbDiGlvNeNfjr86Ai4MO8q4nm0+EXqeHgVNTa/IhRHsFwpLOc7+dkhWRWvRZp9Pu/gn3+pxs0dXAyo9dymZK0aWKpSVY+dhA3T2W5e/HP5RhMViFtW4dfH31GJJ0gWuKok/drsFUv/mgK9cY9jpthMTcRJCiMUTKW+RGmuqZhMV4BJJC5GKdGTzRLmTC1SboJkwKqbWGBIWadEVquq4JP3zQXB9oaGRdQoImAQmeoRJt9juk9ZGxPb5y6KJZKEnhkkBH7XYPzw7Y05VaHsAlAExDLSdQs+3bnh1coFAgnb7k+cbtsZODGRhfWFn10siKM3UIbCC6ERNuCyheJ/LNtlF+/iUAqoGIqeauZKc5tvOwPRXT8qPhdf1d8Ecs+PwJ+CPe1j8BDYT8TfBbEXK+38qdwqSOiqDWDMUB/nXFmoBTkwN180DTIBuMFdjkShWCXOySKIcHn2RgVLCmwHSlqHrhvxUha4v9c+yhnzV32lNt4H6QqOGRSRIRUs+4wcztj2BMjxbgtKCyDhGS4N/W6TBGL7favNhlXwvjkLPmEmDTqLDaHTvV4Y8m5GG/SHDbcBcGdjaEbqbacP9F9cpySMTEz3mweUoX3gpjdcsziOwSSWjj14TUJK8NmsiUwJ0KStnV4Y8lJJNBgwcRKeQS7qmHH4BB+6pjmeg7HqTo3GuNwfuBEuyReOjn51yKPBjW/HoTgrsqs3VVRMSY8gwOZLFpUEGXAOIKGALb2WrCH0vI4hKuPhGlsIA4/ygKPDbfB51hBwTiuljpg/e0rsBifn1cFEdWtdTmbpgN81tkiqknrhl1QkjUI8BOeumdDRtGmg/c1/fsuJDlrWZ5dTWxud3+qFPKX529lswwn7B8yBXP+4GxT7pi3JTPqdoWvn2T0J+dl6PY+pB91prW8ybMf7l2/7dsBBMVFEFOLHIkiSgMFwNj4eR9gmvpNKDTJMjtr5Jf2FKWXgave8bxBBd+UESkE4LMkXgFWBDRiPTXhNnNM2FK0+xavQR1QsiXY+8oo5r63sgTs5GQDBqjpE87x/MMOlcbBolIERvdl5/fmvfyHfUU7+H1K9e7Svit6teu51kkpLjrl7huHm9xu8+WGfA8sTGMWOlXZXwWUe1L03aDmW5ltSEERUTM0/C6QZXEEoWIiI3vlMk/Wdcf+WlVUuBq71Cc9NLtDm/RmX9vkDCXF+/L5GNdcOPzHCloI8/V2rg649t27jj5a8P7XKlK4fzE0mSVwqNuifCtDTiVKCdyXLER8sX7l2Z/ha8+eHPIMTO8zi3Ik2cxmEWUTtrKEO+1cZ8TDF9kvbEIGnWpCX9ai51OcaFe15vo7bTkxHuF0CwP940PGXtFr4hdzGJJMYtQ9QtVwMRV1wEB2kKHkRhECSu4vV1UAuBQ4hNu/+NUnwI1qMaGasDVZFmQpgvmj9ysJV0KvlapoMPiNnWoTp6INRAjIdsamYTfNOISESEvIycwkFpkKdymDgKJiC4SEV0kIrpIRLKSYiQiIvqLciFuLE0u/PoI8MFW9fnD0E6qRXC6U4rAGJACRUQkFqq90auhaUUNMwRKrR+L6GBH1IkfP43UilqhqKTlem3WZZ9eG1zGXJ5+vYO26WNFSbkMt/YjvHufGvPkyuBDlsMvTr59pPcWJyaTWZyVm6W89fmBxUtsZs2xPz705d2Rp0zEXS/kgId2ibVOx0/EDe+VYOcHpUpxqiNiXaHOCRmVFdcCienRYuQ61Mob2WbA3vayrf2LS9hMvD/WZPAODJ9v7DWPUjeUl5HPcW7uSBopGd922DZx1wmV3Pg/rfjcjZWKYWObNDCU42onJxTQYSNBqNupslAkhAN/NtSKkMHRYZ07GrYPiPkU19RAvUmUKGmaKeu/QddIxSAS9V8iJt4RWGUdbuzig267FqZPJt2Zf3ZP9zWDcInZTL11CIaPMRm0qzZ1/BYgTcMzaKBh9Ao2hO+HXU99a0xTHVAXjlbFJs5JZqNhT/jR78pfGGpFSENFvfful+ee3dtv/SBh92dcXHxwi8sKV6Fpd1sXsySZBc+iX3QwN2z7BO3sUKZvEHYnh0RGZce1DNMP79i+qVkwhqGKN2pA16aO3wrUFwpKDoNpHdyhp6EdDDjjBZyyMnIHA5tTAlKSDDT2Bq1Um0Fk+gdyty3u1j3isgHsdGyh0Za2hABDfmQgZdpTUu3GuXlXuPTuAal3lF9SAC1220JpObc5xaVsYNKlIGDseWiioAuNNrcB1pf03wKRCVlQUCBDPNSSqoiIqIqIiBuOh9o2NzAitz7jGJOfiIj7w09X0lKrLyJS8LyxQOCaJsnlKibt6zADiYigtlyPuci1kSjNRwRKdwqJyH+N8HnOVf1DIiI6Hx5Aut9DRITIhFwXvnslWjzS39GJ3VzV8LWFpmnAXDOPxf3OuQab67QJUZCSyz785uzkBA+ustnL6NdtM0qy1WxbWN2xPTHonbf5v0NtDvd/7z/2glFcYrx+k8Z6scYH7LOCRlxs0uFw76Rhxs4HVtr+PQXTet1a6NtVt6Pf4vtrvT94Bsikfk7V0lTTTPmulooASnuPH2wOmzSgFIaatbKaQtMJMx1VMU/+cP5yYrPjQF+xCdgcdYbYrFrvcOdBZEJSZqtiJwcJjIL9x1/gKeuv7MolBMLE0PgF5X844iwZx7/lBSN0DXT1o9F9M+G+ArpILP48d/ZYNQzd4S1dyFmd+iFiKOlqeZsR/Rud97ClCG4sKCkkiYhciHa/KLDoNKLuwRDlVXlLEjfPJwJ+iphoxotJ43IgEhERlZFAbsH/VtSJ1Op2bc7FcjpIBiU+tY10u6d4NPSM+2iLwXs7H3B5HzD+IknM9+kxrYxUDSLRQltUemyLisSkEPAmuGvnlh0f1EU9+aHl3Z7s21KmhZOGG/i5TIYhTbrYL6Ka+Pm3twhisIn73He1GcGxCRW4WRh3U8Qcc3kaBCSGEdKyBGnuA61h8JsA+RbUCSF9em9w4b9GIqJLERGBRES3KjN7FOqDiAiUMqkH2V3fBt5nRpHX1JIVdQ+5Eu9Hpr0TePDa3tgMCZ4QJMz8CNWvPk4kp5XBUrstGfY9BKTwxy5jVYf78YE8f0UlQyTOvbjKn1JJCZpAHGHgD0duDEl+ITTet6CBkL8J/khCVqWu/SvjjyQkbi7YbrV8qEs7p9M4EdFbpsvJec7Tlw6+5PHgjPPurrjXtaysTBJXbvR3dCwpLeOQG+/RkkCboz0y0O8dtH/BsaiLHkGjLumTee6wKB8k47B/i+vqibbHBr3twbI6+79Bc8ndgbjRIWpCABOnICmTvI/DAm2s21v5t9pjl1VYWiiLmx4MvDsVldA4TFzCi8qMbdH1xJA3opr8+60IKYoqJIKfI/knIpCI6OIUIWVbBh8wdV9ZSTmTWh+d1mnCavzz8uR74A9HCe4q5d/MgUREF4mIbuSk+0rUvZhpQbzd5U2V9d/Wxm7jb0XIPxkNez9+AzRw42+ABiL+Bmgg4m+ABiL+Bmgg4m+ABiL+BvgjiYhncIgjHwmZbGB0PC5y/OIyCfDtlAJWqkXAkCjn6cninse3uVIw+7kqRGR/tSonKy2b93bCA/mq8qPwRxIRoSgrBdn5bHKTDr+Z1OrQTEsBPqRUeZZmJcjRy+CJQ7xQ9cdSvl1ZqEJpIFsC561TeWF7YxVgW6ysSOX8sUSkCIjIKywBOemajSs93jYEmo46BE93DQcjV+FabnKMMnjlKHzDTm3grp8DXi2iRVIH+GOJyI+Ca54waeNduBAgfBfwsnGW4OnchvRHHRtXiXPx2xxBEE6Gxv1KV0fAfA7AlKca8DKHCRnFkuSnVIPFgd5a+bCwZWalc2tEwR9NRI1B+wB3VSBHVkVAxJJDIdDJWAu0VGVAQ1mGJBqSqYVSPvhVY18cVfvnvVCFM4nCuzW8j/0ibkXYF61I/imEEZ9hVRGV5f5oIlLbYpCzOAQL8J9KbaynDK/jM3nX7hvuQtwnrkYmFYsp+fVUGQq4pt9biKnj2qL9bT0UbDhvJ9Qc948mIiJi7who436CR0DclJp8yo30J6flgZkHV4McCSjDokNBkXC12WWRKnA4VkHkcvGzqShVRkqsxaUSNRqVqA5/LBHzi0og/6pnpfBSDrdTiieI1t7Tl9QSpxD7pT8kD6zSUYLcklRoel2/2m10mN0kwxyiv8sQeSfxwpeqcCqhxpEFD38sEWVZDLj4KApcujTlSanaQ31IIlKCC0XAm/85g3kzNdKPcdEcy9ukbGKcKA3CZFoUbJ72iCcPOKBQG3lllUk6+WfTZX6cdJqWmaZGo9M5yvJKGXiyMxUuIyNTIM2SFmqTldo+h34qDVOKWSwnJyf6bs1aonsHPdAiCJdCfD6rGyv2/PsSePQ2huUTuMd6Cfv0YcXRFkBV5vwrgj+LqlJQ0m5NEDsRO+zoFW+t2+He1n4rxuG16fGeaRvNFo1Bf5fmVneM9nUpoFQdKBsA6MdDJfDcTNRJwTSbzBaPnhW+4mgjZdXP4aNuqou7ngjD0YdJV5TB/txh7XjxKPMq6C42TgfXJtUbNkopooEFIaiwRCAKbnb90DuWd3qAKBA7EY8O3tbb4dTwiHPbboylCDQ7fOURdEObX9FGlzr1g8Lr1Hdt9VQbxxrusS6m0gyx6X8M/xXjigP5bCbIShXXHJEPRuO+Du53jj4OfU2fVxObIO4rVTgRL8/jOFEISMUzuclV/x9sUFa+WaeGBFAHRGTQGGw8Ca/H6REvzry5OhbD3ro9IC0R5OTlKkjQJcBI3uBVNwPrG7ufHSW3HzmeGcl7Iqhxhm5BYYGM1XGX2ErWf8SA9M0zSTczXw4sVy4gpMOqHwMe92Kglg5BC1ZBCaf6Lur6RxmY9vTrR+N7a349Vb5sswjxxE7EpqpN3k2/u+SoHcvi8uCWfQ6/zYoy2fxi/z94b2pr15XubUduWmI9azZeS0rSyrKKc1Q8O4xdv7jT9L8wbGWQ91qvDmPXbXq+798NpovGOHSwuynuOlJQls2D96tEOyymKgLiTuQu93Vq3B4uTy+DE51SwUSBTR7fIQw46uznr01OhtcGdSLYbLVfNpryVzxuhyIg9x7XmANFQP6wnxkFRL9ldqsJb4qsKgIGd0cJVXBCoCoCIvATdNWGuw0Oo5neby1SfcRGxEkHZ5+IgaRWt1x9zcSRH7/QI25Q5sG2mX8CJ82CGsV/tMjx98tG4Btf/dgNiXrTNgmM5EqqjScKsOGve9bzBPh1tv/wAJezBk4nR4cNUei5Z0fmySVPRl1t3Mane3qE2x3VivHbHeyVksbJ1IyfEFwlof66smx3DqtAdbfDmsHiqic/pj4TFHqRCGW46wnKa9UVe5t/Jl6G6k+ZQS47nywL694qQ1IhXeD0ePLcOIK7+2nnw772HwWWqUSB2IgY7x4sqbvDokxGkpU/ftjoPbuO+S6uKm5gUpidjrxWbFpOFrlF99y766MHNnfiiX+UcPMu+UOrcxMOdBNXHWsCEk5SxGG5uUoRnO6YWm2ctGIadLqrWymcVoFGeClNSKW3CcFI/8uRjmiD7lXfz5XSCoPYiIgDdX41+ZDRV8jaC+NCq8bt718adIB3IDY/ARFoSqUujfzhSYm3P0nDpCcaInNcQakE+Fh+hF4a1R9adeeTDHiEff+wNr9UElrfNPw1JsBjP8cb6qvpRVcM3+C3439zHCcvr6tyHdQLIZoYVCOQkImFNAjPYkF2iQQo0MvBWKEYmsmVAkcExqQRA3O9KwaVOKy+UKdEtDrsHBM49hL5fehzamwIcutE85FbtobsX3R35KnWE2/8df7Vh9cm/pMvtSTuh94YfqwdxkULVO8yolvb61hfY8pJFxvrtXhZl/XEvlCbxQHtCv1adQREw0YtrjcBxpf9pD+KgIh648SIgncW58y3W3Zo1j7UPymkewmnlLGv17oBXbY5R3Y7OfT1w5FnW+D2MjykD02IoXQ6L+I/H4YUo/Sa3uH24qwLSqfnOqdAW4Xazdq8zJGCng8bk/0XgiF8o3C9o06JeNJlh8OHzNiWaInqePetDh1024cmpaXotFFpGUaXpJXGfoo3PNZ/e089Hd34h4nBPWx1Ot7SVNNIvRFzf8AFl/3WLZQNX2bkZzWquaTaY2CAFs+PCk3/tM4gPrH55Lgus0QSnmSwYPZzNcgi/PxMJi3i9Fl9ok6J2ERRh2duzEbX8g66jRtpJY5rNGQH+vXVv/aFSEDK38vA7jzll5eTr352WQzII4SIv57ju1L5ffkVthiLTMQdV/bNmtx34ib0//t44+Z/rWfPRP+eV8fnTGo9cgN/XBxqJEwOrfJj8yg8wK6LWef731bluoFv/x0gw2BBv9NudVrOcOM+cPL1VbHmWTtbcDutipRkFDOdjRx9nyQ9t74Y7Tfi0LszU7cG7Fv4ctLXs1YpAvY/4xYwrLXzgRGtvpwnSkB3t2X5WpuF7pkF2S96nhv1vLCoULqioT/dvR3LE9yDJXYHHJ6VJpGltch6ep1OxZUTv2EXJvOuiU89BI47DxYHnGGosSPMtvAE26PD4JnbTWi9156ME+p6kRDcBkFpWSm8cr9HhHOHs+u7zyVtjs+7uwE29lgAKwO2QXpBLshLycByu+kQmMi1pPF43BnoemQ4lJDp74LJvu7wrXtFa0XEaK9AUj0ZOXF5yJb1u7usHoREzC7JVQ5798yyfXPzEPMDPVOfjb+paXGsb2JjpnqcCkspjT8PR/2uF9H1CTk+7YjNRsfBt70e8d+/F/Kw+y2Hw+Sk4d4nR2feHHdCrEKNMKCZkjLil0QaE7IEC21jkoBoXOh5Wih0OjSQZ2hodbc5MLr1cNDdZgGddc3gUfxTcL0yk5fX7NtrSRMoWxz/BzP8lpNWGpE4eexCmOm3BoYZ9+blpSmnShA4m0g/45sJiBCZiNSnFEF9ShEVp82QgOiGjroidCVsf891/fmvK3JhN0vbO5T/yQw/AVPVdQlJ4qfjbQEMGh0WW88mhkTjhcbDR51WkEH6RxoPgICEcAhNeQ5ruy2GefdW8OLtCOMuOLPoDGBzOOBmNgj2h58hw3LZ3G5+he08mHjtbyJ9BGxxWAYzbi/5prqLTES0IqGkqJT1LcfEZ+ZlqSjLKZEtLyoqYhEoqm0e9QHUqSkt4/AIyG8FivIvvLeB/COm3PyHd58iIGWI6G16HOmWEATEt5wioO/ra+QfgQSk8K0ERIhMRLQgQfktTvZNCh1+pbGlb7/EkGGXdTr6OicED7uk2+mUc/wh6w09W+gYRe56eHC2pCwd/JIfuUzXH7v0rxdrDgaPuqx389mdvnc/B/X1y/IfKCslk/dk+FXtLicHvT/rsKvz/55t2BGU8rQrS5JZWErnMOQkZHL+NZ05vVtLmzpbU+RHVz0LOOYseEhYVVYUEW32dYPMolyBe8KsMW5+sgPWB/nwwrrpd4QjfbdXWU5tUeshRj67QM5Ru8uFkORwm2Ysvdfrz3ovctDqfAnvBQ29pIc2YDTk1ZN9Oq/tqyqn8nlS+9EbH0YE2CMBDXdZF61oMcsjtzBXIXLsPVJJMyo2uqmttqXf+og9K0xVWoVu77ZiOL/h90N+x92h5Te3T2Qc7LcOHJpUPdcuzCBfxMR7MODceAhNjhCaxkaX253vDBPcOUURML0wA+SZMiAlyaqUtjaoNRGRe7zajlmro6Qd96/VnBnN1Q0j33+K5j1mfvsvFGzbdL6LbrTnY7K2I2HIIepeU33DqJX6X81wUiguLWYx6cyicY4j99a2jt8CioCNvdsL6JoiKFObvm/OwpzbXBM22KegIHR+4IEqueiky27Sfevhz4uTUZTFu291uB8UlNRu1kgYvmmwjwREFwmIrpG64ZvvrkkFIAHFnacoQAJ20bWEEy7kfARpD5Ua8lMEBKh5EuCEC/fwlfHXpsOB3ltBS14ZUnIzgZDWeXHeeQSQbmr+J+hwoPc311nsMzauvjMu7HReM0JaWrh+aW3R7/z44MsDDnQUR16iAk1bEl8CfJEEwnEYUJFLq0IX3c6keyuaa6kxdNwtHjeiu9JuJowz4WqxaMqqEwJQKSkZfwvETsSDw7b0b7HPNvftxIekLkMv72HBf3Wd/E/3tl1v4PU/jzdsmWbiumLglUn+OOnNn7bT4X6xxRw2C9cTuzS2vDW75cT/ibt+NcGj3XDY/fQk6Gy3hM8zuEp4Iy9NhuPOO0jjs1pb25F2xB+OqdrK//3RJ3l+/r50XNsBcOjFeSgsLYJF9zeT//gpIaREKyPFJCXZb4HYibg98MA8v/7HTNGfX1xAqioiAT9+/qSBmm0+r3ynj2k6cAd/mkJ2kfT//P7bgkbxqHGm/s5OJdPauq4Ud/2qAmWJ+H/Wc8k/Px7GhxBjuzyQl5KDlOlPK6WriGZKzUjX/TpPJwz2Om2ElbaLSCKmz6y8svatBESInYhTrMavpfyyTJm8G9N8yU+hhpr6Rw1Q/5jgzjUIz8+F0lKswvV9/5nEn0+sVxApINXnpxQJ0khGEUwaGfMM2uopkPrO0GqPHem2UDUgP3/344MF+kW0QsyFBM/Pb7yWPwzLUWDJgE1jC7gWdR++d5r9h6/s/2xIK8gWsEgcnyNoSf9tegz5r/jYBa0QVyZKRSvFOUUFBAEfCI1bWzQQ8TdAAxF/AzQQ8TdAAxF/A/yRRKxLndYfgT+SiKOuTru5wWLxODwqNyT/hd29+MdO79KijC8NPGDFZDCLUNNufuepC6eau672fnZg4TTz8aua7+mS927SI7nA1yE2R2MvTHYwsr2qWaISZ2Vs6Y9aevtfnZwpUyCV3cXI6s7T9Ajr0I/PbVZ1mU/aJt/8ZN+SmR0mLkPD7ws7TZ2vKaeetOj+f9vQDng7n17JT91uaC+6sGpLIx21jFkd3Jfa7HN5N6Wz29pBRr0PS9EZ7Jra80cS8YjTFic8A3mF9V9Tx5kN3THT759D8VNCaGhBnzS+TvAppTfUVbsTbxls3Nnplz1bjf7PPzXUYZvTylHrgnYutwJL0jC7e5uRG80P9kyNKHxnscZuoefs20sPUEQc03QAObkR5xFEb7KrYylqyq8J2c6biN14fvsCLHOqqeuquE8JBrHFSUbDWvTzuRfxyLG7KXemqzr8kUQktwnwbTlAAqJLWc/nv9dWo1UYusiFVNhz41uknv48q8nkfhPKgn/4eD8NKk4M3+FpqsqqaVQ8Km9qmwNyIX/dmqjrxlBxRCEg4o8k4u+GBiL+Bmgg4m+ABiL+Bmg43KQBDfhJ0PBFbUADfhI0MGMDGvCToIEZG9CAnwQNzNiABvwkaGDGBjTgJ0EDM/6kWHBr1Y7VPRZOrjmmaJi48cFpqN0xAXUOCWYB0Js/rNcy8QGgTbHyCmrceIXb4mtjcYopxSza3PXfseKqWwMz/qTAcyfEmd+lgKjBVfHi7MFmsP70M5D8nrNzvgHkoZTlt2qOKCJoBDP52SZBIykOyDHKQVyrdsi8aLjW/oGOwBPEQy8JZhRPIdDAjH8kDv3tAE6WTaDPwssgL82A+SPaQ1sDFXBdd1es5aSedoMXUWngOP8SLwwPXMODSfEsy9oCmUJXphT+1zodeqoXVmsdU5zL52hiFct9X+HkvshiZbF+vRqY8Q/EuP9uk+5ad2tw7dWK9PfuZMA7Tss/IhmCIz+C94UXUFAs/AC7iigq4UBBUQl0N9OBXgSj92inC5LEW2xmpMbLd73vU1h76plIjJhTIglr2qaBh0E2lAgREkSxM1zXaKNQJFY7qg3M+IdClkXnMWIRuxRYUtxXQdQjtCuCxaCR/2dET6itIgOzCNGXHwOWXIOAVylC02LP89g+nhAvKx85KowRqwL2nKWo2x+qAUHp0tWeUCIqsPSmciVw0ioFFOlldWpYtYEZ/1DkF5VWYjwtZRlI9B0POsMOVJmumbYivMfDJat4K1EMPTC/Bxy6EQl/7eXahykmes3xji3hZawUeew6hbYquXC5mkObhQFP2n6dIwUzw9XgVTYT6LU4/u5bgLl/yGNAh1t6AuF4iOYthwxoK8ayGpixAaAix4SMvGJIySyoxIhKxPiuY0sNiIzPhM/ZhfDYezAkfMyFtpNOApMuCaqKLCL8q4Ew7OUqMjmT6DGP33tf63qxiRd+SJAWPM+SEnpmV10zYnXAj8KQQB3OW2Px5dnAjH8Yiks5kHneHdq6n4CPWYXAoEnCm0OjYcrWB3D6wYdK8bOInuxmWALpp8Z+uhryMMq+OZx6+EGAERH81tUOz+sOZx5GwaWg2GrrhCkCM1gwLFBT6GkWNZ1+WBHIojK0MmijyAavZllgr1ZIMrao2WB6KYLZziTJw/b3ihCdL+yAafGjgRn/MDDpNNAcguedl0HGBXde+PbpXcHBXAcO33oLd8MTgUH0evxLHf8b1QEUnfeQvRzCpIky6KrJQcLnyid8lxGiqjQRr1dHffKPPSkyMAJ7XnYpd2z4IkOed2AiojbHyiBzDdbJA3fDbGijUFztmXgltWBEhMSXNC5aeeS/4r3EQjrZY1d/vljt0cCMfyiQ2SpiQJemsPJEGNBpkpXWHJcfe8JjRMTLuMyKyclx5PJxljCpXxuBcGTExgQTlpRWnqARBZ0bFcAm03RQleIIXSmt7eGU3wMsv7F0KTzulgB0prRIJ5qKil+CGXNycxSMD9lnVwxH+zXvM2JadTs+5HXFe77OO+0NWbpvLE71TfZu/++wAVZ9T1WMM/PeP4fPvLo6pqIdHKczY8J6NbW7MMN8Au+owOy8HMXWB+2zKuZBo9M4cZ7Bv8Rz5Aeuw/GP7fA65uhY2DHNFvou/rYTdzCPxQdDYIxjK5Bm0sFw1CHIzGPD/Y0DIMl3PKgN3FelkWCcCdWXLYUDlqmgT7zswpiuNiNEHLsWcyQgJp8Ob/OlYFGEKrlcIvHlXsValH+pP1XGOtPPYE6IuS0V2GQvWR/4JV6ibmeHcs2SE0/RWd3++Li2Q3Z0bN4hgD+OAksu+1yvPZ2p65Y6zV+lfEolT3ObFvavL/7nGkxcMLOP55rBlzweBMWH2Qory2CXFbuktIQRkRrZ7tTLy+MCxlxoJhCBqEPiZK51FXZpiZThLqviujz3ur6APGI45vB359PFRAv0RhzizbZiD9xj3sUvZXAD84uZ8N/gszCl2z1iDFv5FRSV6Vj0Mtj5QQn2xChCCiE60ms45aW6sSdXHe7r9fwXakLjoXj8P+N08DLMEbGWouOXYMYw1xvaaPjrctTtoXPuLvO55HdnJPgBHOvr3VNbQZOcXSgvK5fIkyxUFHbujgQxGOmubX1lfcy+1eu37SPtP223XDZkSuiS0/yU19neAU8MgzivYHpK9sfGnY47x7Xe0y3j1aR7KsLqxaDReavXyMAMOuP7T3SvIySum0f2PuxSGnRZswBSc+TrRFH10csU8qWWJMigIlsIZ7x2gKGa8GOxhTGiMGC9l71RgeNxCqRfGGpiRHEBJ3b+I+qCf1lpWZFOihYVvwQz3v3g7zT2xsxrAoEEwa0bd7gXm5tI9ly57HyF/ucm8HrLMc0H7pxu5sYVMwn542C/zf3QO/y81+2TA3Y6oJ9gRl52TbZbkrJRv8bdT3rum00eU95Nx+r6vcRApw6HeifdGXSSO4lNvA3YE/ISEj1lvGcwDW2U1UnjxQwpOgeCF6+oFM6gcSCviAX+H4zgYrgZxKWpQnq+LNGLSfGYVkaqhGCwfFBXyAa75u/BvlUkNNNMBTZbings3y8Y4HJBSAYLxoZoQiFHfIIGipksWjmoMjmgzSqFRoTbTJ4NjRhckhUQZSUV0SCeEGeTCmmQWkQnj2Vn1PPSyS/BjPbNbK5XJQYaqRhEViciVrxHMSJ5j8+IX9yUkBqfxa8uilaHEg4NmETH3r3Va/IvKoqKmTVHEoJCgkFGBWvC00zWd/dqmHqJcQb0184jJ3nqYkIHT35PJhh24hN1iMz5tjbXhJ+WGXHXwrcc9Vgf5b1MeWNmotUyvI6rJFYY4hIC0bp/WqfDaL3cejsv+00uA4YGaUEh0dMIe7i1YUR92RK4ZJMMMtX0WHU1s4q6sBpEj3q581eVvt9+NlV/Ryd27OQgKX7G+JyZpr7m+c41TrI2vg4W3UhbwmtDd67MLMpWWWI5c/bu18f+KuYUs7ow21+XZrIKjiRfnDqhyZCNumo6cZbH+iSOMR2yy6vV6DU+r3xnpJR81h2t7bLd3Kht2JYXPv/LLchV9GoxevXJD5cnTrFw/W9liPfanKJcpUXmU+cqyCvwRul5+XlyK8K8N2hmKcWsj9+/GnvJl7GvTX1iz8ycYjR6VdPGhrVXMfkBWPpKlfzzo4BglI6NCsGO+HdRKwRrlSJAAY6aYaQg8WUWEv+xBQy4/VEaPhCi3aVkGfhcTAeWmMQ6FClXmqTB4MZ5tdJNrQ6YC26xomZSUTTNJtqN4qgcIa5qEYxW9mU2tZTotX+Ebs9Px4yxX2w3l5WVSert6sjBmUuHcyNeopX2+2WPey5k586dF/nfgaiJAbwzRPc/Oz4jwu2Oqv/LQLvx/n9dk6JLFT+ICXQMG3+9sZKcUuaiTtPIc+J93192o0vSSs++ujo61ihIakPYnmXx44NIah984jvZo93oDadeXnKVZrAKjkWcy6bE2NTPHzX/u7p16SbXlR54vX7b/tVpeRnqY+/Ovo5Ht96JftTnfI89Voa6BlH1/8S+HzL0MojIYpJ/7w9K35THtzAipphqlAXu+jkgR/8+JXFksinP1CCMGHOmEOIkTYwdJNZThRB/PZtmw0SirnXFqD8dMyKmn1p4MDY9vim1hPB8wi11R++hoT1adb06qLPzCfyvvLlpdUjMM+uLnoe7ejQb+R/GszGxuh9u4qfRw3vIk2HtXMijc4NGXWrSfcvAZ0dGbu87o5XrskNBpzzO9t89Au9NaTKKN5MxoeWwzXQavbSnss3Z959iWk5qN2IddU9TTSMVGXHwXrfbmgrqyT2VbM42klP59HjUBcM+u0YGzrQZv+1nZ8TY3rEwNFATAtNZYn1RawK+uLK0MujUqAj2t//0XVufsGd+mS0Fff21q22DuNuH2WWyabA6UoX8U5BmyXLeTxRfOT8lM24dusq1YpjftFMW/NeLes5aQPmn2k5Yy3/v1rTTAodc3plxzhzd0WpD9o62HMI7s/pv+2m8Q1c9u7luQnftgH+8qqrXGXcfB/5rFpNVROX9swNFsOMdUwXCcLbwMcGc55LkwCdGkWQayVq8yMhXbELcw/W+McQ41JYQcR01CsjZS2E8JyojYh1QV3XBC1WIzWdUqlN9fkyqQ22elSj4KZlRVFgddo5ZYj1rNo4vy8rLJHs3sz/Hf//1u8jWxs1bvaopny7bnCMfTL7QWtTlid9hkR+BTGOhXEz+V5ukiyVPdi21VfCFdg9ThzsfZaq8/6fgl2ZGxP9C1m9DehmrNX/elKUXmZGVoWplwj0QqqCwoBKF94QdnT2p/eiNNqcGRvkPPdcUwyh7M7q7LMoTPLmiseEu66Joz8e8cWnnY/2jAkZdaEpdFxYWSq+5471iad95c2ZdWuLzn9NiTymGVI2nff0oDA3WgiMdUmqljC0uYJE5pZKwO0YBNr5RBmn6T7BN/yfEL8+MT0ZebSwQoPMlPPm5NdHTFRcUFcjKsGTyx12befVQ7819uhvYXGVzSqSMVYzCYzITmhko636QAO7MLa2cxrMxUSJRKrCYlJyTqst/TZdilIZlvyTV7zY5L3Ork8aJEU8ymNDqpj7vGmcMm8mxYSnRI3ZXL4AizvdxKYsQcXF3/RqC2V5kM4n8JIT2ag2MWDV+aWYMHHvJoKp7HbRNHwPfWXnIiOg2VdF/i+4eh/8GUfceTbtE2p+I9QribVxL8AgReJVivL6e0EeJqFdGHe70vW34UcCNubg8MS5Es07y/5PES3GhXpmxqoX1InYxiyXFLBKW5luxK/zIX55mY9bVHLMBvzO4a6U4MfUD5PNaok6YcceVfbPO591xvT74SHtch8Mwi4O9E/o0dzj7r/XsmYsur9pyNyvIebHx1Fl92jtesDkx4MOTcdd08ory5XueHhXOAmb+nTG+AuZFMjIzVJKLPumtCtj63/HBO3piWPdtg54VKpYq6spoRX9kpzdml7KZR7psdGyq3/TDpuC9S46+PDcJJ2UejjzbAuNf/XBncJ9m3c8MPjDhTjI9zeBUr51dddS0E3qfHvMEdVvLoVzCf9R5o6WBmzYdeX7GQ1teM+HhqLMtHE4OjyjiFEsT9wR2cBwKPeW5683Rv+ebec13aePkWxfPsr6RMDUU2vn0hJS8z4Ba861Um8KHzLgfWqcygpmSpz3FibNap51gOhzyS3LA9/W1miP/YNRZz3i8x9YeyAi7w4/OsVJpdzfU9Zruv483bvZ7ea+vf+7Tniw6s3D9272rnMwdLn0qTSfHfckpydoBY7iTJHr7O5bHTwgmhZ38gnzZwdc9H+opNo6hMemc+Y9W717TZYGHvKZiwZ3BPuY3Y+7372lgdwHjGu62Lo72eMyUojGK/UefNyLzOtipPN41SCKnOFfJ7dLsC+nMXE2mhFTRmFszbt4dcap1QnayfsTEO40wrt3JIZH3h59u9eJTZPuzLntsm+3qXKCroB3LkKSzux4b9ObBqLMtMR4u+u95c3wutmNzhM8/7dXaPtbRbJxQV8+zvpBdnA3P3PxgbfBmOBPpx2NEuiQNor0CQW2LKTE+lIIbww/B8dfn4EjEJbg6fCc4nXAHCaCBhXZruDDoMGh7tyfX555OuAZ/3V0Gd2ODwd1sKLi2GQHWh/sDp5wDSdPCoPnuzlBYwoa4ycGofcUti0YDTtnXie2yL2pA/GeJYloNoi50STqc6L8ZItOjYLn/NjBU0iXqdgya7exCxnNrOxi8w3xIv6NhZ1ja5S/odNAFSspKIWX6U2i1pysUlbIhZnIg6G2zFFp+faFOmHFQp34nFBQUs5EZPcxGb6DC3ZoO2aynoRvraNLtyq7z+6c5WTlexjinOnrb4P3mBkZvj930dTU1avOUYkTEq9jItndHnjKhrrPzc5RwYmaNxXzSbkTHRuYPqHtnuu0kJ1XuDDrZ+sDVI5PatzAPQUbEsB6Nu1wc0br/vuISNvPQtWMTR/YYchjF5iNdNzlS6bdZLh2G7j77tf0xzgfPAJnUjI9a1x7fdB7rNJK3GxcX/XGvI7YDVfR+B0ZEmOz9upSKTJAwNRha7LaFp+P9QH2LCUjTuRPUTr6uOHaGwy+4exVLiJeXSaNDaDJ3JYmyFDDywnQYZ9qfZMZ/bOYRvVt7cl8jXYIOLfZYE8x6BVrvdgK74wNgk8MSGNrKBWyP9YfozERePai8qP2QV4YcAqPd1sCgcYf4Iy/OIuvyvweb4PaIU2C404qXxufFGV4+Pr23QGOid8V8iI816BJ1+eDlD8132RGSWy9Y130RjDQeCB0P9YWkXME12fpAnTCjRiMNoS1BRqT8ngMmeFP+TiaWvK1Po3oOO1gxnaVxh0D+a0VZhSx0WzZpTm4vUJJX5NmAaNfc9Am66spqH8f3GbOHP10jJVVyYx2TIVU8yWX8dirczKjtU8pvYmj8Al1leaWMcb1H7UO/popGilvfsbuFtYm/Hb8DIifdJ93C0iJQk1aBpQHryZ7DeK8dnOy/AzppdyDEvgLQkFUHve2W5Itd/enXX7fPIyPETg6CjMJMgqlZ8DItEowJRkQF2BvDThAMkEzGi8tOFsgBx3svPkfAK/e7kFaYBl2PDoUNDguhXzMnyCnOAU1ZDaJX7UgyGDJiDFFGAVHHgtICog2N4O/7y8h8dInykwim/ZT/GZh0JqTkJ5GMiOL4w9HnCdE8leyx89j54n6sIkHszLj08aZN7sYjNpRIcKTcr849t6HHP25t1Fo+rTnl9+NhRIC9IkMhw7Rlm3D+8KjEmGaN1bUTxTFJdPT1OY/RxgOFMubvgFZ77ASu8UUlRHEwUNSFbWGHwfvJIchm50BSTiqwOSWk+NrXdzLRK3Inm5E5qbEdpo3LSYLDERegvSbaxZEAu2ODITY7ESgTURLcRES53chrJZYCyDPkeOVnFXN19Xv7jheo15zbq8g/QkdeC7b1XEKWN+XGMjDYIXySG78J2t7tQEVaEfQVdUCBKQPtNFvDR4I5W+7uCpWNcdQv6qRn1FbSJGUMv5EnzOyPDHl5d8xpk7HXZ1477LS597u0aGNpCWZ+11ND3kZ7cRfV3yVFtczKzVK2bNk+cMzF6deOuGztrbvbspxaXiC+wJwPHgHSU07MO7J3zKZhTfZ05Dwf66f2MDGkh3OzHr4lnFLGrMtLfIYa9jmAT3z2jX99/uu+yOPj54+ad+MfO9ELJIqtyi0eLX+8ef2+IRsHo2jc2sc+85XbXeXEjGQ9dm4xfdLD+edvj/E1Jcs7ZFUePy5QYufTw395tRu7Dsess2/+67N7wLphqGiOcYx322W+9rivjH7POwtOe9stH8m/8/9XBr7U90adhObKRjXGZXPYRG9kzbvGyZZX7ndAmaUsUllrg71ha+gh3vXLiYLnfdQ0aYPiKeJK1A3wvLaoShs7w4x7wwb7ZTXWx+aoM8RmJdcYry5QJ8xIdPPyxRw2q99p16Dt9itIpey70f5O+fn5shoM1SQ5Obk8/1HnjIqLi5nNDnUpSpgUImF/eMjLK3qHLDfaLBlXMT9C/i+TojPY3iPWuDbba1MYNymY3Ec2986y/Q7anS8fe3veo6e27Xlqf8/GXv+6Tbm44JiJQvMwr27jNx6/d7pSnpzyMjIPOZZsbnpOkcq/tnNm3Yp80KdzE4t7d11OkOuOhPhFzoczpZjFknLc8UlA4hP7froOJwcb9D4UEvu0c2u1FuFX3t4evKv76iF18SzrGygSxk8JEQhDkbX5ri4kk/KD7N34VqrsmljC0X47BOIs9V8Le8O/2gJDZnk6/hqoyXBtzMzrOI38f8tMKcWIiL5NexHXPUF3u0WleDnF+QKM+DbjLXQ/PqpSPGw7iqm1M+woPoidGf+xnjULXTmQzX089iJPfYx/Vz2Csl2DjIju3bGnyQkaGRkZ0hwl/6J77ORgkhNw5vKDu780Ff7O4xEpz7ibj9pUsR7bXVbznvbIbkPIT6/PsM0DqbA3E+4roKsko5ippK+Y2RQMebsumsnokwawJrcfR+4GweWZnT1WkRM73g7LyXyXOc6byWvbl90lvwPeegiel2h3bBBvRlVbTh16Gla241VaVkpOlFRkRBQJK67v4fjS3McJHA27gE/vr2T74BkAzXZ1BlFQWsaB1OnPKoUjo8dNCYYm2zsKhEvRBF/zFiotBBg5LicGJl1fAK8+f/hhjIj4pTRwniVEWJjrtgmtr/ImHJ15Zv/ozYNrijf3xrK963stca8p3q8AnFjhR2T6e2BIcseDTZX1Ybnt/EppCkoKYfezEwJhZTUstD+IfyxwLerZkNhLp898ybv2TwyG4Rem8JiLJkEjPt6BoL/DihcHx7xaW80heXoYwWqV69REwQBuDjtJ+t9lvgX7Y5V7zfrAL8GMVtv6vD89aE83fkZs5dMtO9LtniL6e3kPC77idayziY99hjxTPtt/+LlmLfbb5qnJNEo9329v5wvBV4cc/XxpGjFW5Dwec7Gp3YkhkekFGWosGquwm771jaWd58xovrtLnqa8elLouKu6Jvu6p8swpPNHtR6wJzMrU7lYskQa9zGGf3jR/lN5pvbH3M9a2yIOLsKPaPDYK03eFsaI8/yTH4qIz6+hjdrXAyQejj7NE+keJYSQ4iSu0X2cHi6QjnheAtfIiIs6T4aVAYK9JQLF3SjPYIGwgedrPgAYlbf4GRFho9NRoJdD0CUZZFhjXEb50tPRJGmg+2UdkR/NVBrD/ZEXedfNlVuAgpQc5LArW0qva/wSzBg49SpvJsHdb965vY5rB1a0romi5DztiX+tTdm/Ds0mNpbWjA1wvWiUX1gge78otN/Q1v0OYry47MSmuN0qYgJ3kd/5nFsg7uxn0qWKkBGzcrKVmqsbRk7WHrli2tOlJ2d0mLDi1rN7Vprm6sm3PzzqM7fXlGVuV2dfHNba+QCuUYZFhwvKRL84nHzHwutJd4kXkpTiK4l01QEZNdT1CmjJcfVdvczdyH9NcL06FcJTK5/zwQ9ZgtnfejwSqR4UkqaG8UTloHEXQEeeu4vgU2EKIZK+A10FbWimVHmSKqs4t95PcUb8EsyIQKviBYWFMlxGJMQnt/uKSSnJjZUUFbNOue7tgWHOVr3PDmEOOC4nK5cXMP6iUcrHVC11NbVPZwbusUO/nKxsnrycfO6NAUd4G4J9e2+3RxcX95NTU7S1NbWSj/bY4piTm6vw0vwOaSymh3m3ayUlJQxkRLz26bPRJfXTR01ZGZl8zO+U9g67en8gdQjjPfZk73XCZQvY6toIjVOVGGpxsC/pdte3goN9t1YzBiuHNvu6Q2ZRzcaAZYQwYlUTPrjUEjv5a6+LanSoDbTi8WbY2XMdWR91aS1Q19OqlLbHyaEQmRb9QxgR8cswIxqH4jcQhWispZ3Ef91ItVEa/7WWhmaKML+MtAzvzBJplnQh5UdGpO7zx0EwGIIGijXVvyo28OfxuwBf2pEXZ35z+juxgYRYWHlmsyYIYzIck4o624qTOxXjInNdeX+f+Ne+PvWJX4YZG9CA3x0NzNiABvwkaGDGBjTgJ0EDMzagAT8JGpjxD0HC5NCff6v7LwZxHz/RwIx/CPDFOXbL17WsvFxyhP3gw5QFhsKiQuljd865mjZt88yiZbsgDDv/6PKQAV36nUb/Bf8rgx3M7W7Iysjmox/DMI9Bts6+VFzMu79NX97GwYCXQbadTTqRenVXAm/079TSwr+Rsio50x36JqxT+IeIdoNtXU4qKyhn8NcRzbJgGej2tOx+TZYly1t5LywulDl2+9S49s3NQs2NTCstfJ65f2EEjcZV4qfqjpbgLwddG9SWaFtH4w6PH4T722fkZpLLVRwOhz7Yrj+pNlRUVMQiwNvR8/xdhHn0x9hmeMRfX6teF/jLuR58q19Keqq2W+8xYt+508CMfwAysjJV2p5wTE/0CpVof8ApafPRQ8vDXK83Ntptk28taep3yH37AIxH2YPta93ros4Oi3JjVaPnXhrDV+K6LfHy0qY9X3pKSVoxQ19FN2oQcJlxVsSK46g7jPEpHd3xj/+6VvqIQ2dJSBVK0mllexVXuxDM6G+wsxP7xehbqhYt2wcdeX3W89KHW8NPO++yo+qJRzpMi1h2CvMJiwrv6HLTPQj9Voeco/sodT252GXOwqz8bGU8R7OirvOsyJXHFRjymbipgGLGDqf6kMtZlpltH5wz9rHramZz93FYoM3MyJUnQkZfIa39sdlsqbYHe6QVlBXJUvU/9fqy64mEy5OipwVK6+7tWD5Buv9//45eMB/LRQkDPz6Op0Y+71DQ4u4q139miYtODcz4s0KM5tVUlJQzNlr/z7XpbusiOSnZnJLSUlLZ9L2Hv2y37QNfGO62KlaVVvkcPzmE3MnCoDHY+GL6hd/t42hmzztTXIEln11WXkZ78/kDz+qCHFOOXPtVkVZKWxO8ffX8jlMWyLPkcu64nDBWUlTKehQf7CCRzxXn0MKexaE+CWmFGRrGcs2eXR19pJL2koKUXHarfXbZOgpacRRzBI67ZNjj1IgXPrus5jSSVf0oTOSWkpQqKodySQ7Ra1OGz1SkldNy2XmKbBkOz34uSgRyTNlc9KPJTrPDPT9FTrqvyCnn0I32dMl/P+mRLFOKWcSSZhW33m+f4aUzYtVCp5mLMD4eotv2QI/PBSUFco46thdWDRUfI5J1E2dmDRAf1jgsrPKYgW/BUFPnQ/ivGH5vyrkq9Wr5GZEQATmvJ95Tqhjn5QSultKL8bd4526Hjb3OM5LZRa/jbf74qHJYVXlVlYG4NfREtfq/UR4B0hXDXrjdqnQWuKWpRdBdU19S+VaK+OhQ5dGAxkFGRP+S3nP+XgJz/q5UP0kaJ8LtdqPq6vE9aGDGBjTgJ0EDMzagAT8JGpixAQ34SfB/bmKcH6wcoy0AAAAASUVORK5CYII=';

/* ============================ 2. MASCARAMENTO DE NUVENS ============================ */
// O script original usava a banda QA60 (bits 10/11) para nuvem e cirro. O QA60
// é apenas um classificador binário e comete bastante erro de omissão (deixa
// passar nuvens finas e cirros), além de sofrer com mudanças no processamento
// do Sentinel-2 pela ESA. A própria equipe do Earth Engine recomenda hoje o
// dataset "Cloud Score+", que dá uma nota contínua (0–1) de "quão limpo" está
// cada pixel — mais preciso e mais fácil de ajustar por região/projeto.
// Fonte: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED
var CLOUD_SCORE_PLUS = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');

function maskWithCloudScorePlus(image) {
  var clearMask = image.select('cs_cdf').gte(CLOUD_SCORE_THRESHOLD);
  return image.updateMask(clearMask)
    .divide(10000)
    .copyProperties(image, ['system:time_start']);
}

// Método antigo (QA60), mantido comentado apenas como referência/backup caso
// seja necessário comparar os dois métodos:
// function maskS2cloudsLegacy(image) {
//   var qa = image.select('QA60');
//   var cloudBitMask = 1 << 10;
//   var cirrusBitMask = 1 << 11;
//   var mask = qa.bitwiseAnd(cloudBitMask).eq(0).and(qa.bitwiseAnd(cirrusBitMask).eq(0));
//   return image.updateMask(mask).divide(10000).copyProperties(image, ['system:time_start']);
// }

// Monta uma coleção Sentinel-2 já filtrada, "linkada" ao Cloud Score+ e
// mascarada — usada tanto para os mosaicos anuais quanto para as séries temporais.
function getMaskedS2Collection(geometry, cloudThreshold) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geometry)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudThreshold))
    .linkCollection(CLOUD_SCORE_PLUS, ['cs_cdf'])
    .map(maskWithCloudScorePlus);
}

/* ============================ 3. ÍNDICE DE VEGETAÇÃO (EVI) ============================ */
// Renomeado de "calculateEVIMean" para "calculateEVI": a função não calcula
// nenhuma média, apenas o EVI por pixel de uma única imagem — o nome antigo
// sugeria uma redução espacial/temporal que não existia.
function calculateEVI(image) {
  var evi = image.expression(
    '2.5 * (NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1)',
    {
      NIR: image.select('B8'),
      RED: image.select('B4'),
      BLUE: image.select('B2')
    }).rename('EVI');
  return evi.set('system:time_start', image.get('system:time_start'));
}

/* ============================ 4. COMPOSIÇÕES ANUAIS (SEM REPETIÇÃO) ============================ */
// O script original tinha 8 blocos idênticos (I2018...I2025) e mais 8 blocos
// de EVI — só mudava o ano. Aqui vira uma função + um laço, então adicionar
// 2026 é só mudar END_YEAR em vez de copiar/colar ~10 linhas nesta seção e
// mais ~10 na exibição dos layers.
function getYearlyImages(year, geometry) {
  var start = ee.Date.fromYMD(year, 1, 1);
  var end = start.advance(1, 'year');
  var composite = getMaskedS2Collection(geometry, CLOUD_THRESHOLD_COMPOSITE)
    .filterDate(start, end)
    .median();
  return {
    rgb: composite.clip(geometry),
    evi: calculateEVI(composite).clip(geometry)
  };
}

function buildYearlyImages(startYear, endYear, geometry) {
  var images = {};
  for (var year = startYear; year <= endYear; year++) {
    images[year] = getYearlyImages(year, geometry);
  }
  return images;
}

/* ============================ 5. MAPBIOMAS (SEM REPETIÇÃO) ============================ */
function buildMapbiomasImages(startYear, endYear, geometry) {
  var mapbiomas10 = ee.Image('projects/mapbiomas-public/assets/brazil/lulc_10m/collection2/mapbiomas_10m_collection2_integration_v1');
  var images = {};
  for (var year = startYear; year <= endYear; year++) {
    images[year] = mapbiomas10.select('classification_' + year).clip(geometry);
  }
  return images;
}

var mapbiomasPalette = require('users/mapbiomas/modules:Palettes.js').get('classification8');
var MAPBIOMAS_VIS = {palette: mapbiomasPalette, min: 0, max: 62};

/* ============================ 6. LOGO E LEGENDAS (FUNÇÕES REUTILIZÁVEIS) ============================ */
// Cada painel de UI só pode ter um widget "pai" por vez, então precisamos de
// uma nova instância de ui.Chart a cada chamada — mas a string gigante do
// base64 agora existe uma única vez (LOGO_BASE64, lá em cima).
function buildLogoPanel(padding) {
  var logoImg = '<img src="data:image/png;base64, ' + LOGO_BASE64 + '">';
  var logoChart = ui.Chart([[logoImg]], 'Table', {allowHtml: true, backgroundColor: 'black'});
  return ui.Panel([logoChart], 'flow', {width: '500px', position: 'bottom-left', padding: padding || '2px'});
}

// Legenda do Mapbiomas (LULC) — função para poder ser reconstruída do zero a
// cada consulta, sem acumular itens de execuções anteriores.
//
// São 14 classes, o que ocupa cerca de 300 px de altura e come um pedaço sério
// do mapa. Por isso a legenda é recolhível: um ui.Button alterna a propriedade
// de estilo 'shown' do painel com os itens. Recolhida, sobra só a barra de
// título (~30 px); o widget continua montado, então abrir e fechar é instantâneo
// e não recalcula nada.
//
// options.collapsible  (padrão true)  — false devolve a legenda fixa e aberta,
//                                       usada no relatório, onde ela precisa
//                                       aparecer inteira ao imprimir.
// options.startExpanded(padrão false) — estado inicial quando recolhível.
function buildLulcLegendPanel(options) {
  options = options || {};
  var collapsible = options.collapsible !== false;
  var expanded = options.startExpanded === true;

  var itemsPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {margin: '2px 0 0 0', shown: expanded || !collapsible}
  });

  for (var key in MAPBIOMAS_CLASSES) {
    var colorBox = ui.Panel({
      style: {backgroundColor: MAPBIOMAS_COLORS[key], padding: '6px', margin: '0 0 2px 0'}
    });
    var classLabel = ui.Label({
      value: MAPBIOMAS_CLASSES[key],
      style: {margin: '0 0 2px 6px', fontSize: '11px'}
    });
    itemsPanel.add(ui.Panel({
      widgets: [colorBox, classLabel],
      layout: ui.Panel.Layout.Flow('horizontal'),
      style: {margin: '0'}
    }));
  }

  var container = ui.Panel({style: {position: 'bottom-right', padding: '6px'}});

  if (!collapsible) {
    container.add(ui.Label({
      value: 'Legenda - Uso e Cobertura (MapBiomas)',
      style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 3px 0'}
    }));
    container.add(itemsPanel);
    return container;
  }

  var TITLE = ' Legenda - Uso e Cobertura';
  var toggle = ui.Button({
    label: (expanded ? '▾' : '▸') + TITLE,
    style: {margin: '0', padding: '0'},
    onClick: function () {
      expanded = !expanded;
      itemsPanel.style().set('shown', expanded);
      toggle.setLabel((expanded ? '▾' : '▸') + TITLE);
    }
  });

  container.add(toggle);
  container.add(itemsPanel);
  return container;
}

// Legenda de EVI (barra de cores contínua).
// Agora devolve também as referências dos rótulos, para que os valores possam
// ser reescritos quando o usuário liga o realce relativo do EVI.
function buildEviLegendPanel() {
  function makeColorBarParams(palette, nSteps) {
    return {bbox: [0, 0, nSteps, 0.1], dimensions: '100x6', format: 'png', min: 0, max: nSteps, palette: palette};
  }
  var colorBar = ui.Thumbnail({
    image: ee.Image.pixelLonLat().select(0).int(),
    params: makeColorBarParams(EVI_VIS.palette, 7),
    style: {stretch: 'horizontal', margin: '0px 8px', maxHeight: '24px'}
  });
  var minLabel = ui.Label(EVI_VIS.min, {margin: '2px 6px'});
  var midLabel = ui.Label((EVI_VIS.max - EVI_VIS.min) / 2 + EVI_VIS.min, {margin: '2px 6px', textAlign: 'center', stretch: 'horizontal'});
  var maxLabel = ui.Label(EVI_VIS.max, {margin: '2px 6px'});
  var legendLabels = ui.Panel({
    widgets: [minLabel, midLabel, maxLabel],
    layout: ui.Panel.Layout.flow('horizontal')
  });
  var legendTitle = ui.Label({value: 'Valores de EVI', style: {fontWeight: 'bold'}});
  var panel = ui.Panel([legendTitle, colorBar, legendLabels]);
  return {
    panel: panel,
    setRange: function (min, max) {
      minLabel.setValue(min.toFixed(2));
      midLabel.setValue(((max - min) / 2 + min).toFixed(2));
      maxLabel.setValue(max.toFixed(2));
    }
  };
}

/* ============================ 6b. REALCE POR PERCENTIS ============================ */
// Mede o histograma real da área e devolve, por banda, o par [percentil baixo,
// percentil alto]. É esse par que vira o min/max da visualização.
// Assíncrono (evaluate) para não travar a interface.
function computePercentileStretch(image, bands, geometry, percentiles, scale, callback) {
  image.select(bands)
    .reduceRegion({
      reducer: ee.Reducer.percentile(percentiles),
      geometry: geometry,
      scale: scale,
      maxPixels: 1e9,
      bestEffort: true
    })
    .evaluate(function (result, error) {
      if (error || !result) {
        callback(null, error || 'Sem resposta do servidor.');
        return;
      }
      var lo = [];
      var hi = [];
      for (var i = 0; i < bands.length; i++) {
        var loValue = result[bands[i] + '_p' + percentiles[0]];
        var hiValue = result[bands[i] + '_p' + percentiles[1]];
        // Área totalmente mascarada por nuvem, ou histograma degenerado
        // (min == max) devolveria uma imagem preta; nesses casos avisamos o
        // chamador para que ele use o valor fixo de segurança.
        if (loValue === null || hiValue === null ||
            loValue === undefined || hiValue === undefined ||
            hiValue <= loValue) {
          callback(null, 'Histograma insuficiente (área muito pequena ou coberta por nuvem).');
          return;
        }
        lo.push(loValue);
        hi.push(hiValue);
      }
      callback({min: lo, max: hi}, null);
    });
}

/* ============================ 6c. TENDÊNCIA DA VEGETAÇÃO ============================ *
 * POR QUE NÃO UMA REGRESSÃO LINEAR SIMPLES (mínimos quadrados)?
 * Série de EVI viola quase todas as premissas dos mínimos quadrados: tem
 * sazonalidade forte, resíduos autocorrelacionados, distribuição não normal e
 * outliers (nuvem/sombra residual, queimada pontual). Um único ano de seca ou
 * uma cena contaminada inclina a reta e muda a conclusão.
 *
 * O padrão consolidado na literatura de séries de índices de vegetação é:
 *   - Declividade de Theil-Sen: mediana das declividades entre todos os pares
 *     de pontos. Não-paramétrica; suporta até ~29% de outliers sem se deslocar.
 *   - Teste de Mann-Kendall: informa se a tendência é estatisticamente
 *     significativa (não exige normalidade).
 *   - Mann-Kendall Sazonal (Hirsch-Slack) para a série mensal: compara janeiro
 *     com janeiro, junho com junho etc., de modo que o ciclo de plantio/pastagem
 *     não seja confundido com tendência.
 *
 * A reta desenhada nos gráficos é a de Theil-Sen — e não a "trendline" padrão
 * do Google Charts, que é de mínimos quadrados.
 */

var SERIES_SCALE = 20;        // (m) escala da extração da série. O script original
                              // usava 200 m nos gráficos, o que em polígono de
                              // poucos hectares devolve pouquíssimo (ou nenhum) pixel.
var TREND_ALPHA = 0.05;       // nível de significância do Mann-Kendall
var SLOPE_NEGLIGIBLE = 0.005; // |EVI/ano| abaixo disso = praticamente estável
var SLOPE_STRONG = 0.020;     // |EVI/ano| acima disso = variação acentuada
var AMPLITUDE_HIGH = 0.25;    // amplitude sazonal típica de lavoura (plantio/colheita)
var AMPLITUDE_MODERATE = 0.15;// amplitude típica de pastagem manejada / seca marcada
var MIN_OBS_MONTHLY = 24;     // mínimo de meses válidos para opinar
var MIN_OBS_ANNUAL = 5;       // mínimo de anos válidos para opinar

/* ---- Utilitários estatísticos (JavaScript puro, do lado do cliente) ---- */
function median(values) {
  if (!values.length) { return null; }
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Função de distribuição acumulada da normal padrão (aproximação de
// Abramowitz & Stegun 7.1.26) — usada para o p-valor do Mann-Kendall.
function normalCdf(z) {
  var sign = z < 0 ? -1 : 1;
  var x = Math.abs(z) / Math.sqrt(2);
  var t = 1 / (1 + 0.3275911 * x);
  var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Declividade de Theil-Sen: mediana das declividades de todos os pares.
function theilSen(xs, ys) {
  var slopes = [];
  for (var i = 0; i < xs.length - 1; i++) {
    for (var j = i + 1; j < xs.length; j++) {
      var dx = xs[j] - xs[i];
      if (dx !== 0) { slopes.push((ys[j] - ys[i]) / dx); }
    }
  }
  var slope = median(slopes);
  if (slope === null) { return null; }
  // Intercepto robusto: mediana de (y - slope*x)
  var residuals = [];
  for (var k = 0; k < xs.length; k++) { residuals.push(ys[k] - slope * xs[k]); }
  return {slope: slope, intercept: median(residuals)};
}

// Estatística S e variância do Mann-Kendall, com correção para empates.
function mannKendallS(ys) {
  var n = ys.length;
  var S = 0;
  for (var i = 0; i < n - 1; i++) {
    for (var j = i + 1; j < n; j++) {
      var d = ys[j] - ys[i];
      S += (d > 0) - (d < 0);
    }
  }
  var counts = {};
  for (var k = 0; k < n; k++) {
    var key = ys[k].toFixed(6);
    counts[key] = (counts[key] || 0) + 1;
  }
  var tieTerm = 0;
  for (var c in counts) {
    var t = counts[c];
    if (t > 1) { tieTerm += t * (t - 1) * (2 * t + 5); }
  }
  var varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  return {S: S, varS: varS, n: n};
}

function zFromS(S, varS) {
  if (varS <= 0) { return 0; }
  if (S > 0) { return (S - 1) / Math.sqrt(varS); }
  if (S < 0) { return (S + 1) / Math.sqrt(varS); }
  return 0;
}

function pValueTwoSided(z) {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Mann-Kendall clássico (série já livre de sazonalidade, ex.: médias anuais).
function mannKendall(ys) {
  var mk = mannKendallS(ys);
  var z = zFromS(mk.S, mk.varS);
  return {z: z, p: pValueTwoSided(z), n: mk.n};
}

// Mann-Kendall Sazonal: soma S e Var(S) calculados DENTRO de cada mês, para
// que o ciclo anual de plantio/pastagem não vire "tendência".
function seasonalMannKendall(points) {
  var byMonth = {};
  for (var i = 0; i < points.length; i++) {
    var m = points[i].month;
    if (!byMonth[m]) { byMonth[m] = []; }
    byMonth[m].push(points[i].value);
  }
  var totalS = 0;
  var totalVar = 0;
  var used = 0;
  for (var key in byMonth) {
    if (byMonth[key].length < 3) { continue; }
    var mk = mannKendallS(byMonth[key]);
    totalS += mk.S;
    totalVar += mk.varS;
    used += mk.n;
  }
  if (totalVar <= 0) { return {z: 0, p: 1, n: used}; }
  var z = zFromS(totalS, totalVar);
  return {z: z, p: pValueTwoSided(z), n: used};
}

/* ---- Extração da série temporal para o lado do cliente ---- */
// Uma única ida ao servidor: o EVI médio da área por cena. Tudo o mais
// (agregação mensal, anual, climatologia, tendência) é derivado aqui.
function extractEviSeries(eviCollection, geometry, scale, callback) {
  var fc = ee.FeatureCollection(eviCollection.map(function (img) {
    var mean = img.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: geometry,
      scale: scale,
      maxPixels: 1e9,
      bestEffort: true
    }).get('EVI');
    return ee.Feature(null, {t: img.date().millis(), evi: mean});
  })).filter(ee.Filter.notNull(['evi']));

  fc.evaluate(function (result, error) {
    if (error || !result || !result.features) {
      callback(null, error || 'Não foi possível extrair a série de EVI.');
      return;
    }
    var points = [];
    for (var i = 0; i < result.features.length; i++) {
      var p = result.features[i].properties;
      if (p.evi === null || p.evi === undefined || !isFinite(p.evi)) { continue; }
      var date = new Date(p.t);
      points.push({
        t: p.t,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        value: p.evi
      });
    }
    points.sort(function (a, b) { return a.t - b.t; });
    if (points.length === 0) {
      callback(null, 'Nenhuma observação válida de EVI no período.');
      return;
    }
    callback(points, null);
  });
}

/* ---- Agregações ---- */
function aggregateBy(points, keyFn) {
  var buckets = {};
  var order = [];
  for (var i = 0; i < points.length; i++) {
    var key = keyFn(points[i]);
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(points[i]);
  }
  var out = [];
  for (var k = 0; k < order.length; k++) {
    var group = buckets[order[k]];
    var sum = 0;
    for (var g = 0; g < group.length; g++) { sum += group[g].value; }
    out.push({
      key: order[k],
      year: group[0].year,
      month: group[0].month,
      count: group.length,
      value: sum / group.length
    });
  }
  out.sort(function (a, b) { return (a.year - b.year) || (a.month - b.month); });
  return out;
}

function toMonthlyMeans(points) {
  return aggregateBy(points, function (p) { return p.year + '-' + p.month; });
}

function toAnnualMeans(monthlyPoints) {
  // Média das médias mensais: evita que um mês com muitas cenas domine o ano.
  return aggregateBy(monthlyPoints, function (p) { return String(p.year); });
}

// Ano decimal — eixo X contínuo, e a declividade sai direto em EVI por ano.
function decimalYear(point) {
  return point.year + (point.month - 0.5) / 12;
}

// Climatologia mensal e amplitude sazonal média (assinatura de manejo).
function seasonalProfile(monthlyPoints) {
  var byMonth = {};
  for (var i = 0; i < monthlyPoints.length; i++) {
    var m = monthlyPoints[i].month;
    if (!byMonth[m]) { byMonth[m] = []; }
    byMonth[m].push(monthlyPoints[i].value);
  }
  var climatology = {};
  var values = [];
  for (var key in byMonth) {
    var sum = 0;
    for (var j = 0; j < byMonth[key].length; j++) { sum += byMonth[key][j]; }
    var mean = sum / byMonth[key].length;
    climatology[key] = mean;
    values.push(mean);
  }
  if (!values.length) { return {climatology: {}, amplitude: null, monthsCovered: 0}; }
  return {
    climatology: climatology,
    amplitude: Math.max.apply(null, values) - Math.min.apply(null, values),
    monthsCovered: values.length
  };
}

// Média móvel centrada de 12 meses: remove o ciclo anual e deixa visível
// apenas o movimento de fundo da vegetação.
function movingAverage(series, window) {
  var half = Math.floor(window / 2);
  var out = [];
  for (var i = 0; i < series.length; i++) {
    if (i < half || i >= series.length - half) { out.push(null); continue; }
    var sum = 0;
    for (var j = i - half; j <= i + half; j++) { sum += series[j].value; }
    out.push(sum / (2 * half + 1));
  }
  return out;
}

/* ---- Análise completa de uma série ---- */
function analyseSeries(series, isSeasonal) {
  var xs = [];
  var ys = [];
  for (var i = 0; i < series.length; i++) {
    xs.push(decimalYear(series[i]));
    ys.push(series[i].value);
  }
  var fit = theilSen(xs, ys);
  if (!fit) { return null; }

  var test = isSeasonal ?
    seasonalMannKendall(series.map(function (p) { return {month: p.month, value: p.value}; })) :
    mannKendall(ys);

  return {
    n: series.length,
    slope: fit.slope,              // EVI por ano
    intercept: fit.intercept,
    p: test.p,
    z: test.z,
    significant: test.p < TREND_ALPHA,
    firstX: xs[0],
    lastX: xs[xs.length - 1],
    fittedAt: function (x) { return fit.intercept + fit.slope * x; }
  };
}

/* ============================ 6d. DIAGNÓSTICO ============================ *
 * ATENÇÃO — LEIA ANTES DE USAR EM PROCESSO ADMINISTRATIVO:
 * O texto gerado abaixo é uma TRIAGEM automatizada por sensoriamento remoto.
 * Ele NÃO caracteriza infração e não substitui vistoria. Um EVI em queda pode
 * ser seca, incêndio, ataque de praga, mudança fenológica natural ou nuvem
 * residual; um EVI estável pode ser tanto pastagem mantida (irregular) quanto
 * vegetação nativa madura (regular). Por isso toda mensagem sai acompanhada da
 * declividade, do p-valor, do número de observações e da ressalva.
 */
var DIAG_COLORS = {
  alerta: {bg: '#fdecea', fg: '#b3261e'},
  atencao: {bg: '#fff4e5', fg: '#8a5300'},
  regular: {bg: '#e8f5e9', fg: '#1b5e20'},
  neutro:  {bg: '#eceff1', fg: '#37474f'}
};

function formatSlope(slope) {
  return (slope >= 0 ? '+' : '') + slope.toFixed(4) + ' EVI/ano';
}

function formatP(p) {
  return p < 0.001 ? 'p < 0,001' : 'p = ' + p.toFixed(3);
}

// Diagnóstico da série MENSAL: tendência dessazonalizada + assinatura de ciclo.
function diagnoseMonthly(stats, profile) {
  if (!stats || stats.n < MIN_OBS_MONTHLY) {
    return {
      level: 'neutro',
      title: 'Série insuficiente para diagnóstico',
      text: 'Apenas ' + (stats ? stats.n : 0) + ' meses com observação válida (mínimo de ' +
            MIN_OBS_MONTHLY + '). Cobertura de nuvens ou polígono muito pequeno. ' +
            'Avalie visualmente as composições anuais.'
    };
  }

  var amp = profile.amplitude;
  var cyclePart;
  if (amp === null) {
    cyclePart = '';
  } else if (amp >= AMPLITUDE_HIGH) {
    cyclePart = ' A amplitude sazonal média é alta (' + amp.toFixed(2) + ' de EVI), padrão compatível com ' +
                'ciclo de plantio e colheita — em área embargada, isso por si só é indício de uso continuado.';
  } else if (amp >= AMPLITUDE_MODERATE) {
    cyclePart = ' A amplitude sazonal média é moderada (' + amp.toFixed(2) + ' de EVI), compatível com ' +
                'pastagem manejada ou com a estação seca do Cerrado.';
  } else {
    cyclePart = ' A amplitude sazonal média é baixa (' + amp.toFixed(2) + ' de EVI), padrão mais próximo de ' +
                'cobertura permanente do que de cultivo cíclico.';
  }

  var base = 'Mann-Kendall Sazonal sobre ' + stats.n + ' meses: ' + formatSlope(stats.slope) + ', ' + formatP(stats.p) + '.';

  if (stats.significant && stats.slope <= -SLOPE_NEGLIGIBLE) {
    return {
      level: 'alerta',
      title: 'INDÍCIO DE POSSÍVEL DESCUMPRIMENTO — verificar',
      text: base + ' Há redução significativa do vigor da vegetação mesmo descontada a sazonalidade,' +
            ' o que é incompatível com a regeneração esperada em área embargada.' + cyclePart
    };
  }
  if (stats.significant && stats.slope >= SLOPE_NEGLIGIBLE) {
    return {
      level: 'regular',
      title: 'Compatível com regeneração',
      text: base + ' Há aumento significativo do vigor da vegetação descontada a sazonalidade,' +
            ' comportamento esperado de área em recuperação.' + cyclePart
    };
  }
  if (amp !== null && amp >= AMPLITUDE_HIGH) {
    return {
      level: 'atencao',
      title: 'ATENÇÃO — ciclo agrícola aparente sem tendência de recuperação',
      text: base + ' A tendência não é significativa (área estável).' + cyclePart
    };
  }
  return {
    level: 'atencao',
    title: 'Sem tendência significativa',
    text: base + ' A área está estável no período: não há sinal de supressão, mas também não há sinal de' +
          ' recuperação do vigor da vegetação.' + cyclePart
  };
}

// Diagnóstico da série ANUAL: já livre de sazonalidade por construção.
function diagnoseAnnual(stats) {
  if (!stats || stats.n < MIN_OBS_ANNUAL) {
    return {
      level: 'neutro',
      title: 'Série anual insuficiente para diagnóstico',
      text: 'Apenas ' + (stats ? stats.n : 0) + ' anos com observação válida (mínimo de ' + MIN_OBS_ANNUAL + ').'
    };
  }

  var magnitude = Math.abs(stats.slope) >= SLOPE_STRONG ? 'acentuada' : 'moderada';
  var totalChange = stats.slope * (stats.lastX - stats.firstX);
  var base = 'Theil-Sen sobre ' + stats.n + ' médias anuais: ' + formatSlope(stats.slope) + ', ' + formatP(stats.p) +
             '. Variação acumulada estimada no período: ' + (totalChange >= 0 ? '+' : '') + totalChange.toFixed(3) + ' de EVI.';

  if (stats.significant && stats.slope <= -SLOPE_NEGLIGIBLE) {
    return {
      level: 'alerta',
      title: 'INDÍCIO DE POSSÍVEL DESCUMPRIMENTO — perda ' + magnitude + ' de vegetação',
      text: base + ' A trajetória plurianual é de perda de vigor da vegetação, incompatível com a' +
            ' regeneração esperada em área embargada. Confirme nas composições RGB e no Mapbiomas' +
            ' em qual ano a mudança ocorre antes de instruir o processo.'
    };
  }
  if (stats.significant && stats.slope >= SLOPE_NEGLIGIBLE) {
    return {
      level: 'regular',
      title: 'Compatível com regularidade — recuperação ' + magnitude,
      text: base + ' A trajetória plurianual é de ganho de vigor da vegetação, comportamento esperado de' +
            ' área embargada em regeneração.'
    };
  }
  return {
    level: 'atencao',
    title: 'Sem tendência plurianual significativa',
    text: base + ' Não há evidência estatística de ganho nem de perda. Em área embargada, a ausência de' +
          ' recuperação ao longo de anos merece verificação — pode indicar uso continuado que apenas' +
          ' mantém a cobertura constante.'
  };
}

var DIAG_DISCLAIMER = 'Resultado indicativo, obtido por sensoriamento remoto. Não caracteriza infração e não ' +
  'substitui vistoria: quedas de EVI também podem decorrer de seca, incêndio, praga ou nuvem residual.';

function buildDiagnosisPanel(diag) {
  var colors = DIAG_COLORS[diag.level] || DIAG_COLORS.neutro;
  return ui.Panel({
    widgets: [
      ui.Label(diag.title, {fontWeight: 'bold', fontSize: '13px', color: colors.fg, margin: '0 0 4px 0'}),
      ui.Label(diag.text, {fontSize: '12px', margin: '0 0 4px 0'}),
      ui.Label(DIAG_DISCLAIMER, {fontSize: '10px', color: '#555', margin: '0'})
    ],
    style: {backgroundColor: colors.bg, padding: '8px', margin: '0 0 10px 0'}
  });
}

/* ============================ 7. INTERFACE INICIAL ============================ */
// var table = ee.FeatureCollection('...'); // <- ajuste conforme comentário no topo

var codeInput = ui.Textbox({placeholder: 'Insira o codigo_pro'});
var statusLabel = ui.Label('', {color: 'red', fontSize: '12px'});

var mainPanel = ui.Panel({
  widgets: [
    ui.Label('Monitoramento de Embargos de Goiás', {fontWeight: 'bold', fontSize: '22px'}),
    codeInput,
    ui.Button('Aplicar', function () { applyFilters(); }),
    statusLabel,
    ui.Label('Governo do Estado de Goiás', {fontWeight: 'bold', fontSize: '14px'}),
    ui.Label('Secretaria de Estado de Meio Ambiente e Desenvolvimento Sustentável - SEMAD/GO', {fontWeight: 'bold', fontSize: '12px'}),
    ui.Label('Gerência de Geoprocessamento e Sensoriamento Remoto', {fontWeight: 'bold', fontSize: '12px'}),
    ui.Label('Vicente de Paula Sousa Júnior | Analista Ambiental | Me. Eng. Cartógrafo e Agrimensor', {fontSize: '12px'}),
    buildLogoPanel('2px')
  ],
  layout: ui.Panel.Layout.flow('vertical'),
  style: {width: '500px', position: 'bottom-right'}
});

// ATENÇÃO: o objeto global "Map" do Code Editor NÃO é um ui.Widget comum —
// ele é o mapa padrão gerenciado pelo próprio editor. Depois de um
// ui.root.clear() ele não pode ser re-adicionado com ui.root.add(Map)
// (erro: "Only a ui.Widget can be added to a panel"). Por isso criamos aqui
// a nossa própria instância de ui.Map, que pode ser removida e re-adicionada
// à vontade — é o que permite o botão "Nova consulta" funcionar sem recarregar
// a página.
var initialMap = ui.Map();
initialMap.setOptions('SATELLITE');

// Volta para a tela inicial sem precisar recarregar a página (o script
// original pedia isso explicitamente na aba de instruções).
function showInitialUI() {
  ui.root.clear();
  initialMap.layers().reset();
  initialMap.setCenter(STUDY_CENTER.lon, STUDY_CENTER.lat, STUDY_CENTER.zoom);
  ui.root.add(initialMap);
  ui.root.add(mainPanel);
}

/* ============================ 8. FLUXO PRINCIPAL (COM VALIDAÇÃO) ============================ */
// applyFilters agora só é chamado pelo clique do botão "Aplicar" — no script
// original, o próprio Textbox tinha onChange: updateFilters, então TODO o
// processamento pesado (8 anos de imagem + gráficos) rodava de novo a cada
// vez que o campo perdia o foco, mesmo sem o usuário pedir. Isso também podia
// disparar o processamento duas vezes (textbox + botão) para o mesmo clique.
function applyFilters() {
  var selectedValue = (codeInput.getValue() || '').trim();

  if (!selectedValue) {
    statusLabel.setValue('Informe um código_pro antes de clicar em "Aplicar".');
    return;
  }

  statusLabel.setValue('Buscando feição e processando imagens, aguarde...');

  var areaEstudo = table.filter(ee.Filter.eq('codigo_pro', selectedValue));

  // Validação: sem isso, um código inexistente resultava em uma
  // FeatureCollection vazia e o script quebrava (ou ficava com mapas em
  // branco) ao tentar centralizar/clipar sobre uma geometria vazia.
  areaEstudo.size().evaluate(function (count, error) {
    if (error) {
      statusLabel.setValue('Erro ao consultar a tabela: ' + error);
      return;
    }
    if (count === 0) {
      statusLabel.setValue('Nenhuma feição encontrada para o código "' + selectedValue + '".');
      return;
    }
    buildResultsUI(areaEstudo, selectedValue);
  });
}

function buildResultsUI(areaEstudo, selectedValue) {
  var geom = areaEstudo.geometry();
  var empty = ee.Image().byte();
  var contorno = empty.paint({featureCollection: areaEstudo, color: 1, width: 2});

  var yearlyImages = buildYearlyImages(START_YEAR, END_YEAR, areaEstudo);
  var mapbiomasImages = buildMapbiomasImages(MAPBIOMAS_START_YEAR, MAPBIOMAS_END_YEAR, areaEstudo);

  /* ---- Gráficos: coleção para série temporal (limiar de nuvem mais permissivo) ---- */
  var timeSeriesCollection = getMaskedS2Collection(areaEstudo, CLOUD_THRESHOLD_TIMESERIES)
    .filterDate(START_YEAR + '-01-01', (END_YEAR + 1) + '-01-01');
  var eviCollection = timeSeriesCollection.map(calculateEVI);

  var years = ee.List.sequence(START_YEAR, END_YEAR);
  var eviAnual = ee.ImageCollection.fromImages(years.map(function (year) {
    var anual = eviCollection.filter(ee.Filter.calendarRange(year, year, 'year')).mean().clip(areaEstudo);
    return anual.set('year', year).set('system:time_start', ee.Date.fromYMD(year, 1, 1));
  }));

  /* ---- Série extraída para o cliente: base dos gráficos E do diagnóstico ---- *
   * Os gráficos deixaram de ser ui.Chart.image.seriesByRegion porque agora
   * precisam desenhar uma reta de Theil-Sen calculada aqui. Como efeito
   * colateral positivo, o gráfico "mensal" passou a ser de fato uma média
   * mensal (antes plotava uma linha por cena, apesar do título).
   */
  var seriesState = {
    points: null, monthly: null, annual: null, profile: null,
    monthlyStats: null, annualStats: null,
    monthlyDiag: null, annualDiag: null,
    error: null
  };

  // Placeholders trocados assim que a série chega do servidor.
  var monthlyChartHolder = ui.Panel({style: {margin: '0'}});
  var annualChartHolder = ui.Panel({style: {margin: '0'}});
  var monthlyDiagHolder = ui.Panel({style: {margin: '0'}});
  var annualDiagHolder = ui.Panel({style: {margin: '0'}});
  monthlyChartHolder.add(ui.Label('Calculando série mensal...', {color: 'gray', fontSize: '12px'}));
  annualChartHolder.add(ui.Label('Calculando série anual...', {color: 'gray', fontSize: '12px'}));

  function buildMonthlyChart() {
    if (!seriesState.monthly) { return ui.Label('Série mensal indisponível.', {color: 'gray', fontSize: '12px'}); }
    var monthly = seriesState.monthly;
    var stats = seriesState.monthlyStats;
    var ma = movingAverage(monthly, 12);
    var table = [['Ano', 'EVI mensal', 'Média móvel 12 meses', 'Tendência (Theil-Sen)']];
    for (var i = 0; i < monthly.length; i++) {
      var x = decimalYear(monthly[i]);
      table.push([x, monthly[i].value, ma[i], stats ? stats.fittedAt(x) : null]);
    }
    return ui.Chart(table, 'LineChart', {
      title: 'Sentinel-2: EVI médio mensal (' + START_YEAR + '–' + END_YEAR + ')',
      hAxis: {title: 'Ano', format: '####'},
      vAxis: {title: 'EVI'},
      interpolateNulls: false,
      series: {
        0: {color: '#7fb3d5', lineWidth: 1, pointSize: 3},
        1: {color: '#1f6f8b', lineWidth: 3, pointSize: 0},
        2: {color: '#c0392b', lineWidth: 2, pointSize: 0, lineDashStyle: [6, 4]}
      }
    });
  }

  function buildAnnualChart() {
    if (!seriesState.annual) { return ui.Label('Série anual indisponível.', {color: 'gray', fontSize: '12px'}); }
    var annual = seriesState.annual;
    var stats = seriesState.annualStats;
    var table = [['Ano', 'EVI médio anual', 'Tendência (Theil-Sen)']];
    for (var i = 0; i < annual.length; i++) {
      var x = annual[i].year;
      table.push([x, annual[i].value, stats ? stats.fittedAt(x + 0.5) : null]);
    }
    return ui.Chart(table, 'LineChart', {
      title: 'Sentinel-2: EVI médio anual (' + START_YEAR + '–' + END_YEAR + ')',
      hAxis: {title: 'Ano', format: '####'},
      vAxis: {title: 'EVI'},
      series: {
        0: {color: '#1f6f8b', lineWidth: 2, pointSize: 6},
        1: {color: '#c0392b', lineWidth: 2, pointSize: 0, lineDashStyle: [6, 4]}
      }
    });
  }

  extractEviSeries(eviCollection, geom, SERIES_SCALE, function (points, error) {
    if (error) {
      seriesState.error = error;
      monthlyChartHolder.clear();
      annualChartHolder.clear();
      monthlyChartHolder.add(ui.Label('Não foi possível montar a série: ' + error, {color: '#b3261e', fontSize: '12px'}));
      return;
    }
    seriesState.points = points;
    seriesState.monthly = toMonthlyMeans(points);
    seriesState.annual = toAnnualMeans(seriesState.monthly);
    seriesState.profile = seasonalProfile(seriesState.monthly);
    // A série mensal usa Mann-Kendall SAZONAL; a anual, o clássico.
    seriesState.monthlyStats = analyseSeries(seriesState.monthly, true);
    seriesState.annualStats = analyseSeries(seriesState.annual, false);
    seriesState.monthlyDiag = diagnoseMonthly(seriesState.monthlyStats, seriesState.profile);
    seriesState.annualDiag = diagnoseAnnual(seriesState.annualStats);

    monthlyChartHolder.clear();
    monthlyChartHolder.add(buildMonthlyChart());
    monthlyDiagHolder.clear();
    monthlyDiagHolder.add(buildDiagnosisPanel(seriesState.monthlyDiag));

    annualChartHolder.clear();
    annualChartHolder.add(buildAnnualChart());
    annualDiagHolder.clear();
    annualDiagHolder.add(buildDiagnosisPanel(seriesState.annualDiag));
  });

  /* ---- Realce: estado compartilhado ---- */
  // Mediana de TODOS os anos: é dela que sai o realce único aplicado a todos
  // os anos (ver comentário na seção de configuração).
  var allYearsMedian = getMaskedS2Collection(areaEstudo, CLOUD_THRESHOLD_COMPOSITE)
    .filterDate(START_YEAR + '-01-01', (END_YEAR + 1) + '-01-01')
    .median();

  var RGB_BANDS = ['B4', 'B3', 'B2'];
  var FALLBACK_RGB_VIS = {bands: RGB_BANDS, min: 0, max: 0.3};

  var rgbVis = FALLBACK_RGB_VIS;   // atualizado assim que o realce é calculado
  var eviVis = {min: EVI_VIS.min, max: EVI_VIS.max, palette: EVI_PALETTE};

  var rgbLayers = [];              // referências para atualizar sem recriar o mapa
  var eviLayers = [];
  var eviLegend = buildEviLegendPanel();
  var stretchStatus = ui.Label('Calculando realce...', {fontSize: '11px', color: 'gray'});

  /* ---- Mapas em tela dividida ---- */
  function display1() {
    var map = ui.Map();
    map.setOptions('SATELLITE');
    map.addLayer(contorno, {palette: 'Blue'}, 'Limite do Polígono');
    for (var y1 = START_YEAR; y1 <= END_YEAR; y1++) {
      var rgbLayer = ui.Map.Layer(yearlyImages[y1].rgb, rgbVis, 'Sentinel-2 (RGB): ' + y1, false);
      rgbLayers.push(rgbLayer);
      map.layers().add(rgbLayer);
    }
    for (var my1 = MAPBIOMAS_START_YEAR; my1 <= MAPBIOMAS_END_YEAR; my1++) {
      map.addLayer(mapbiomasImages[my1], MAPBIOMAS_VIS, 'Mapbiomas 10: ' + my1, false);
    }
    // A legenda do Mapbiomas volta a ficar no mapa que realmente exibe as
    // classes de uso e cobertura (no script original ela ficava, sem motivo
    // aparente, no painel de gráficos ao lado do mapa de EVI).
    // No mapa a legenda nasce recolhida, para não tomar a tela.
    map.add(buildLulcLegendPanel({collapsible: true, startExpanded: false}));
    map.centerObject(areaEstudo, 15);
    return map;
  }

  function display2() {
    var map = ui.Map();
    map.setOptions('SATELLITE');
    map.addLayer(contorno, {palette: 'Blue'}, 'Limite do Polígono');
    for (var y2 = START_YEAR; y2 <= END_YEAR; y2++) {
      var eviLayer = ui.Map.Layer(yearlyImages[y2].evi, eviVis, 'Sentinel-2 (EVI): ' + y2, false);
      eviLayers.push(eviLayer);
      map.layers().add(eviLayer);
    }
    map.add(eviLegend.panel);
    map.centerObject(areaEstudo, 15);
    return map;
  }

  var display = [display1(), display2()];
  ui.root.widgets().reset(display);
  var linker = ui.Map.Linker(display); // sincroniza pan/zoom entre os dois mapas

  /* ---- Aplicação do realce (assíncrona, sem recriar os mapas) ---- */
  function applyRgbStretch(presetName) {
    var percentiles = STRETCH_PRESETS[presetName];

    if (!percentiles) { // opção "Fixo 0-0.3 (original)"
      rgbVis = FALLBACK_RGB_VIS;
      for (var i = 0; i < rgbLayers.length; i++) {
        rgbLayers[i].setVisParams(rgbVis);
      }
      stretchStatus.setValue('Realce: fixo 0–0.3 (igual ao script original).');
      return;
    }

    stretchStatus.setValue('Calculando realce (' + presetName + ')...');
    computePercentileStretch(allYearsMedian, RGB_BANDS, geom, percentiles, STRETCH_SCALE,
      function (stretch, error) {
        if (error) {
          rgbVis = FALLBACK_RGB_VIS;
          stretchStatus.setValue('Não foi possível calcular o realce (' + error + '). Usando 0–0.3.');
        } else {
          rgbVis = {bands: RGB_BANDS, min: stretch.min, max: stretch.max, gamma: RGB_GAMMA};
          stretchStatus.setValue('Realce ' + presetName + ' aplicado a todos os anos (comparáveis entre si).');
        }
        for (var i = 0; i < rgbLayers.length; i++) {
          rgbLayers[i].setVisParams(rgbVis);
        }
      });
  }

  function applyEviStretch(enabled) {
    if (!enabled) {
      eviVis = {min: EVI_VIS.min, max: EVI_VIS.max, palette: EVI_PALETTE};
      eviLegend.setRange(EVI_VIS.min, EVI_VIS.max);
      for (var i = 0; i < eviLayers.length; i++) {
        eviLayers[i].setVisParams(eviVis);
      }
      return;
    }
    var eviMedian = calculateEVI(allYearsMedian);
    computePercentileStretch(eviMedian, ['EVI'], geom, EVI_STRETCH_PERCENTILES, STRETCH_SCALE,
      function (stretch, error) {
        if (error) { return; }
        eviVis = {min: stretch.min[0], max: stretch.max[0], palette: EVI_PALETTE};
        eviLegend.setRange(stretch.min[0], stretch.max[0]);
        for (var i = 0; i < eviLayers.length; i++) {
          eviLayers[i].setVisParams(eviVis);
        }
      });
  }

  var stretchSelect = ui.Select({
    items: Object.keys(STRETCH_PRESETS),
    value: DEFAULT_STRETCH,
    onChange: applyRgbStretch,
    style: {stretch: 'horizontal'}
  });

  var eviStretchCheckbox = ui.Checkbox({
    label: 'Realçar EVI (contraste relativo à área)',
    value: false,
    onChange: applyEviStretch
  });

  applyRgbStretch(DEFAULT_STRETCH); // dispara o cálculo inicial

  var graphPanel = ui.Panel({
    widgets: [
      buildLogoPanel('8px'),
      ui.Label('Código consultado: ' + selectedValue, {fontWeight: 'bold'}),

      ui.Label('Contraste das imagens RGB:', {fontWeight: 'bold'}),
      stretchSelect,
      stretchStatus,
      eviStretchCheckbox,
      ui.Label('Atenção: com o realce de EVI ligado, a escala deixa de ser absoluta e ' +
               'os limiares 0.2 / 0.5 / 0.8 descritos abaixo não se aplicam.',
               {fontSize: '11px', color: 'gray'}),

      ui.Label('EVI médio mensal (captura a sazonalidade):', {fontWeight: 'bold'}),
      monthlyChartHolder,
      monthlyDiagHolder,
      ui.Label('EVI médio anual (tendência plurianual):', {fontWeight: 'bold'}),
      annualChartHolder,
      annualDiagHolder,

      ui.Label('Relatório:', {fontWeight: 'bold', fontSize: '16px'}),
      ui.Button('Gerar relatório (imprimível em PDF)', function () {
        buildReportUI({
          areaEstudo: areaEstudo,
          geom: geom,
          selectedValue: selectedValue,
          yearlyImages: yearlyImages,
          mapbiomasImages: mapbiomasImages,
          eviAnual: eviAnual,
          buildMonthlyChart: buildMonthlyChart,
          buildAnnualChart: buildAnnualChart,
          seriesState: seriesState,
          // Passamos os parâmetros de visualização ATUAIS, para que o relatório
          // saia exatamente com o realce que o analista viu na tela.
          getRgbVis: function () { return rgbVis; },
          getEviVis: function () { return eviVis; },
          backToResults: function () { buildResultsUI(areaEstudo, selectedValue); }
        });
      }),
      ui.Label('Instruções de Interpretação:', {fontWeight: 'bold', fontSize: '16px'}),
      ui.Label('Ative a visualização em Layers.'),
      ui.Button('Nova consulta', showInitialUI), // substitui o antigo "atualize a página"
      ui.Label('O EVI, ou Índice de Vegetação Aperfeiçoado, é uma medida que avalia o conteúdo de vegetação em uma determinada área com base nas informações espectrais provenientes de imagens de sensoriamento remoto. Sua fórmula incorpora três bandas espectrais principais: o infravermelho próximo (NIR), o vermelho (R) e o azul (BLUE) da luz refletida.'),
      ui.Label('0 < EVI < 0.2: Geralmente representa áreas com características como água, nuvens, neve ou outras superfícies não vegetadas.'),
      ui.Label('0.2 < EVI < 0.5: Corresponde a áreas com vegetação escassa ou solo exposto, indicando condições onde a cobertura vegetal é limitada.'),
      ui.Label('0.5 < EVI < 0.8: Indica áreas com vegetação moderada a densa, englobando ecossistemas como florestas e culturas agrícolas saudáveis.'),
      ui.Label('EVI > 0.8: Sinaliza áreas de vegetação muito densa, como florestas tropicais exuberantes ou cultivos extremamente saudáveis.'),
      ui.Label('Governo do Estado de Goiás - Secretaria de Estado de Meio Ambiente e Desenvolvimento Sustentável - SEMAD/GO', {fontWeight: 'bold', fontSize: '12px'}),
      ui.Label('Gerência de Geoprocessamento e Sensoriamento Remoto', {fontWeight: 'bold', fontSize: '12px'}),
      ui.Label('Autor | Executivo Público Ambiental I', {fontSize: '12px'}),
      ui.Label('FONTE: SEMAD/GO - SENTINEL-2 MSI HARMONIZED - MAPBIOMAS BETA 10 m - GOOGLE CLOUD SCORE+', {fontSize: '10px'})
    ],
    layout: ui.Panel.Layout.flow('vertical'),
    style: {width: '500px', position: 'bottom-left'}
  });

  ui.root.add(graphPanel);
}

/* ============================ 9. RELATÓRIO ============================ *
 * NOTA HONESTA SOBRE PDF: o Earth Engine não tem nenhuma API que escreva PDF.
 * O que dá para fazer, e é o que este bloco faz, são três caminhos que juntos
 * cobrem a necessidade:
 *
 *  1) PDF de verdade: montamos aqui uma página de relatório em coluna única,
 *     com largura fixa, e o analista usa Ctrl+P > "Salvar como PDF" do próprio
 *     navegador. É o caminho mais rápido para anexar ao processo.
 *  2) Arquivos de imagem: getFilmstripThumbURL gera UM PNG com todos os anos
 *     empilhados (ótimo para ilustrar evolução temporal) e getVideoThumbURL
 *     gera um GIF animado. Os links são impressos no Console e podem ser
 *     salvos. Atenção: esses links expiram em ~2 horas.
 *  3) Dados brutos para o anexo técnico: Export.image.toDrive (GeoTIFF por ano)
 *     e Export.table.toDrive (CSV da série de EVI). Lembre que exportação no
 *     GEE não começa sozinha — ela aparece na aba "Tasks" e precisa do RUN.
 */

function buildReportThumb(image, params, caption) {
  return ui.Panel({
    widgets: [
      ui.Thumbnail({image: image, params: params, style: {margin: '0px', width: REPORT_THUMB_SIZE + 'px'}}),
      ui.Label(caption, {fontSize: '11px', textAlign: 'center', stretch: 'horizontal', margin: '2px 0 8px 0'})
    ],
    style: {margin: '0 6px 0 0'}
  });
}

function buildReportUI(ctx) {
  var thumbBase = {dimensions: REPORT_THUMB_SIZE, region: ctx.geom, format: 'png'};

  function withBase(vis) {
    var params = {dimensions: thumbBase.dimensions, region: thumbBase.region, format: thumbBase.format};
    for (var k in vis) { params[k] = vis[k]; }
    return params;
  }

  var rgbVis = ctx.getRgbVis();
  var eviVis = ctx.getEviVis();

  var reportPanel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {width: '920px', padding: '12px'}
  });

  /* ---- Cabeçalho ---- */
  reportPanel.add(buildLogoPanel('4px'));
  reportPanel.add(ui.Label('RELATÓRIO DE MONITORAMENTO DE ÁREA EMBARGADA',
    {fontWeight: 'bold', fontSize: '20px', margin: '8px 0 2px 0'}));
  reportPanel.add(ui.Label('Governo do Estado de Goiás — SEMAD/GO — Gerência de Geoprocessamento e Sensoriamento Remoto',
    {fontSize: '12px', margin: '0 0 8px 0'}));
  reportPanel.add(ui.Label('Código do processo (codigo_pro): ' + ctx.selectedValue, {fontWeight: 'bold'}));
  reportPanel.add(ui.Label('Emitido em: ' + new Date().toLocaleString('pt-BR')));

  var areaLabel = ui.Label('Área do polígono: calculando...');
  reportPanel.add(areaLabel);
  ctx.areaEstudo.geometry().area(1).divide(10000).evaluate(function (ha, error) {
    areaLabel.setValue(error ? 'Área do polígono: indisponível' :
      'Área do polígono: ' + ha.toFixed(2) + ' ha');
  });

  reportPanel.add(ui.Label('Período analisado: ' + START_YEAR + ' a ' + END_YEAR +
    ' (Sentinel-2 MSI, mediana anual, nuvens removidas por Cloud Score+ ≥ ' + CLOUD_SCORE_THRESHOLD + ')',
    {fontSize: '12px'}));

  /* ---- Barra de ações (não sai bem na impressão, mas fica no topo) ---- */
  var actionStatus = ui.Label('', {fontSize: '11px', color: 'gray'});
  reportPanel.add(ui.Panel({
    widgets: [
      ui.Button('Voltar', ctx.backToResults),
      ui.Button('Imprimir / Salvar em PDF', function () { buildPrintableHtml(ctx, rgbVis, eviVis, actionStatus); }),
      ui.Button('Links PNG/GIF (só no Code Editor)', function () { generateDownloadLinks(ctx, rgbVis, eviVis, actionStatus); }),
      ui.Button('GeoTIFF + CSV no Drive (só no Code Editor)', function () { queueDriveExports(ctx, actionStatus); })
    ],
    layout: ui.Panel.Layout.flow('horizontal'),
    style: {margin: '8px 0 0 0'}
  }));
  reportPanel.add(actionStatus);

  /* ---- Evolução temporal animada (RGB) ---- */
  // Cada ano é "visualizado" (vira RGB 0–255) antes de entrar na animação,
  // por isso a animação não recebe min/max.
  var rgbFrames = [];
  var eviFrames = [];
  for (var y = START_YEAR; y <= END_YEAR; y++) {
    rgbFrames.push(ctx.yearlyImages[y].rgb.visualize(rgbVis));
    eviFrames.push(ctx.yearlyImages[y].evi.visualize(eviVis));
  }
  var rgbAnim = ee.ImageCollection.fromImages(rgbFrames);
  var eviAnimCol = ee.ImageCollection.fromImages(eviFrames);
  var animParams = {
    dimensions: REPORT_ANIM_SIZE,
    region: ctx.geom,
    framesPerSecond: REPORT_ANIM_FPS,
    crs: 'EPSG:3857'
  };

  reportPanel.add(ui.Label('1. Evolução temporal — animação (' + START_YEAR + '–' + END_YEAR + ')',
    {fontWeight: 'bold', fontSize: '15px', margin: '14px 0 4px 0'}));
  reportPanel.add(ui.Panel({
    widgets: [
      buildReportThumb(rgbAnim, animParams, 'Cor natural (RGB) — 1 quadro por ano'),
      buildReportThumb(eviAnimCol, animParams, 'EVI — 1 quadro por ano')
    ],
    layout: ui.Panel.Layout.flow('horizontal')
  }));

  /* ---- Grade ano a ano ---- */
  reportPanel.add(ui.Label('2. Composições anuais — RGB, EVI e Uso/Cobertura',
    {fontWeight: 'bold', fontSize: '15px', margin: '14px 0 4px 0'}));
  reportPanel.add(ui.Label('Todas as imagens RGB usam o MESMO realce, o que as torna comparáveis entre si.',
    {fontSize: '11px', color: 'gray'}));

  for (var yr = START_YEAR; yr <= END_YEAR; yr++) {
    var row = ui.Panel({layout: ui.Panel.Layout.flow('horizontal'), style: {margin: '6px 0'}});
    row.add(ui.Label(String(yr), {fontWeight: 'bold', fontSize: '14px', margin: '110px 8px 0 0'}));
    row.add(buildReportThumb(ctx.yearlyImages[yr].rgb, withBase(rgbVis), 'RGB ' + yr));
    row.add(buildReportThumb(ctx.yearlyImages[yr].evi, withBase(eviVis), 'EVI ' + yr));
    if (ctx.mapbiomasImages[yr]) {
      row.add(buildReportThumb(ctx.mapbiomasImages[yr], withBase(MAPBIOMAS_VIS), 'Mapbiomas ' + yr));
    } else {
      row.add(ui.Label('Mapbiomas indisponível para ' + yr,
        {fontSize: '11px', color: 'gray', margin: '110px 0 0 0'}));
    }
    reportPanel.add(row);
  }

  // No relatório ela precisa estar sempre aberta — um botão recolhido não
  // apareceria no PDF impresso.
  reportPanel.add(buildLulcLegendPanel({collapsible: false}));

  /* ---- Gráficos (instâncias novas, exclusivas do relatório) ---- */
  reportPanel.add(ui.Label('3. Série temporal de EVI e análise de tendência',
    {fontWeight: 'bold', fontSize: '15px', margin: '14px 0 4px 0'}));
  reportPanel.add(ctx.buildMonthlyChart());
  if (ctx.seriesState.monthlyDiag) {
    reportPanel.add(buildDiagnosisPanel(ctx.seriesState.monthlyDiag));
  }
  reportPanel.add(ctx.buildAnnualChart());
  if (ctx.seriesState.annualDiag) {
    reportPanel.add(buildDiagnosisPanel(ctx.seriesState.annualDiag));
  }

  /* ---- Rodapé ---- */
  reportPanel.add(ui.Label('FONTE: SEMAD/GO — SENTINEL-2 MSI HARMONIZED — MAPBIOMAS 10 m (Coleção 2) — GOOGLE CLOUD SCORE+',
    {fontSize: '10px', margin: '14px 0 0 0'}));
  reportPanel.add(ui.Label('Vicente de Paula Sousa Júnior | Analista Ambiental | Me. Eng. Cartógrafo e Agrimensor',
    {fontSize: '11px'}));

  ui.root.clear();
  ui.root.add(reportPanel);
}

/* ============================ 9b. RELATÓRIO HTML IMPRIMÍVEL ============================ *
 * POR QUE NÃO DÁ PARA "SÓ CHAMAR window.print()" DAQUI:
 * o JavaScript do Code Editor roda em sandbox e não enxerga o objeto window da
 * página; além disso, um ui.Panel alto tem rolagem própria, e o navegador
 * imprime apenas a parte visível dele — o PDF sairia cortado.
 *
 * E EM APP PUBLICADO (earthengine.app) é pior: não existe aba Console nem aba
 * Tasks, então print() e Export.* simplesmente não têm para onde ir.
 *
 * A saída é gerar um documento HTML autônomo (CSS de impressão A4, quebras de
 * página controladas, botão real de imprimir) e entregá-lo pela PRÓPRIA
 * interface, em três camadas — link de download, visualização para impressão
 * embutida e caixa de texto para copiar. Ver showReportDelivery().
 *
 * IMPORTANTE: os links de miniatura do Earth Engine expiram em ~2 horas. Abra
 * o HTML e gere o PDF no mesmo dia — ao imprimir, as imagens ficam embutidas no
 * PDF e aí sim o arquivo é permanente.
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Converte todo caractere acentuado em entidade numérica (&#233; etc.), deixando
// o arquivo em ASCII puro. Motivo prático: o relatório é salvo copiando e
// colando no Bloco de Notas, e se o usuário salvar em ANSI em vez de UTF-8 os
// acentos viram lixo. Em ASCII puro o arquivo fica correto em QUALQUER
// codificação — elimina a fonte de erro em vez de instruir contra ela.
function toAsciiEntities(text) {
  var out = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    out += code > 126 ? '&#' + code + ';' : text.charAt(i);
  }
  return out;
}

// Gráfico de linhas em SVG puro: sem dependência externa, imprime perfeito.
function svgLineChart(config) {
  var width = config.width || 760;
  var height = config.height || 260;
  var pad = {left: 52, right: 16, top: 16, bottom: 34};
  var xs = config.xs;
  var seriesList = config.series;

  var allValues = [];
  for (var s = 0; s < seriesList.length; s++) {
    for (var v = 0; v < seriesList[s].values.length; v++) {
      var val = seriesList[s].values[v];
      if (val !== null && val !== undefined && isFinite(val)) { allValues.push(val); }
    }
  }
  if (!xs.length || !allValues.length) { return '<p>Série indisponível.</p>'; }

  var xMin = Math.min.apply(null, xs);
  var xMax = Math.max.apply(null, xs);
  var yMin = Math.min.apply(null, allValues);
  var yMax = Math.max.apply(null, allValues);
  var yPad = (yMax - yMin) * 0.1 || 0.05;
  yMin -= yPad;
  yMax += yPad;

  function px(x) { return pad.left + (x - xMin) / ((xMax - xMin) || 1) * (width - pad.left - pad.right); }
  function py(y) { return height - pad.bottom - (y - yMin) / ((yMax - yMin) || 1) * (height - pad.top - pad.bottom); }

  var parts = ['<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" style="max-width:' + width + 'px">'];

  // Eixos e grade horizontal
  for (var g = 0; g <= 4; g++) {
    var yv = yMin + (yMax - yMin) * g / 4;
    var yy = py(yv);
    parts.push('<line x1="' + pad.left + '" y1="' + yy + '" x2="' + (width - pad.right) + '" y2="' + yy +
               '" stroke="#e0e0e0" stroke-width="1"/>');
    parts.push('<text x="' + (pad.left - 6) + '" y="' + (yy + 4) + '" font-size="10" text-anchor="end" fill="#555">' +
               yv.toFixed(2) + '</text>');
  }
  // Marcas do eixo X em anos inteiros
  for (var yr = Math.ceil(xMin); yr <= Math.floor(xMax); yr++) {
    var xx = px(yr);
    parts.push('<line x1="' + xx + '" y1="' + pad.top + '" x2="' + xx + '" y2="' + (height - pad.bottom) +
               '" stroke="#f0f0f0" stroke-width="1"/>');
    parts.push('<text x="' + xx + '" y="' + (height - pad.bottom + 14) + '" font-size="10" text-anchor="middle" fill="#555">' +
               yr + '</text>');
  }

  // Séries
  for (var i = 0; i < seriesList.length; i++) {
    var serie = seriesList[i];
    var d = '';
    var pen = false;
    for (var k = 0; k < xs.length; k++) {
      var value = serie.values[k];
      if (value === null || value === undefined || !isFinite(value)) { pen = false; continue; }
      d += (pen ? ' L ' : ' M ') + px(xs[k]).toFixed(1) + ' ' + py(value).toFixed(1);
      pen = true;
    }
    parts.push('<path d="' + d + '" fill="none" stroke="' + serie.color + '" stroke-width="' + (serie.width || 2) +
               '"' + (serie.dashed ? ' stroke-dasharray="6,4"' : '') + '/>');
    if (serie.points) {
      for (var q = 0; q < xs.length; q++) {
        var pv = serie.values[q];
        if (pv === null || pv === undefined || !isFinite(pv)) { continue; }
        parts.push('<circle cx="' + px(xs[q]).toFixed(1) + '" cy="' + py(pv).toFixed(1) + '" r="2.5" fill="' + serie.color + '"/>');
      }
    }
  }

  // Legenda
  var legendX = pad.left;
  for (var L = 0; L < seriesList.length; L++) {
    parts.push('<rect x="' + legendX + '" y="' + (pad.top - 10) + '" width="14" height="3" fill="' + seriesList[L].color + '"/>');
    parts.push('<text x="' + (legendX + 18) + '" y="' + (pad.top - 6) + '" font-size="10" fill="#333">' +
               escapeHtml(seriesList[L].name) + '</text>');
    legendX += 18 + seriesList[L].name.length * 5.6 + 16;
  }

  parts.push('</svg>');
  return parts.join('');
}

function diagnosisHtml(diag) {
  if (!diag) { return ''; }
  var colors = DIAG_COLORS[diag.level] || DIAG_COLORS.neutro;
  return '<div class="diag" style="background:' + colors.bg + ';border-left:4px solid ' + colors.fg + '">' +
         '<p class="diag-title" style="color:' + colors.fg + '">' + escapeHtml(diag.title) + '</p>' +
         '<p>' + escapeHtml(diag.text) + '</p>' +
         '<p class="small">' + escapeHtml(DIAG_DISCLAIMER) + '</p></div>';
}

function buildPrintableHtml(ctx, rgbVis, eviVis, statusWidget) {
  statusWidget.setValue('Montando o relatório HTML... isso pode levar alguns segundos.');

  var thumbBase = {dimensions: REPORT_THUMB_SIZE, region: ctx.geom, format: 'png'};
  function withBase(vis) {
    var params = {dimensions: thumbBase.dimensions, region: thumbBase.region, format: thumbBase.format};
    for (var k in vis) { params[k] = vis[k]; }
    return params;
  }

  // Coletor: dispara todos os pedidos de miniatura e só monta o HTML quando o
  // último responder (ou falhar).
  var jobs = [];
  for (var y = START_YEAR; y <= END_YEAR; y++) {
    jobs.push({year: y, kind: 'RGB', image: ctx.yearlyImages[y].rgb, params: withBase(rgbVis)});
    jobs.push({year: y, kind: 'EVI', image: ctx.yearlyImages[y].evi, params: withBase(eviVis)});
    if (ctx.mapbiomasImages[y]) {
      jobs.push({year: y, kind: 'Mapbiomas', image: ctx.mapbiomasImages[y], params: withBase(MAPBIOMAS_VIS)});
    }
  }

  var urls = {};
  var pending = jobs.length;
  var areaHa = null;

  function finishIfReady() {
    if (pending > 0 || areaHa === null) { return; }
    // A entrega acontece na própria interface — nada de Console, que não
    // existe em app publicado.
    showReportDelivery(ctx, assembleReportHtml(ctx, urls, areaHa));
  }

  ctx.areaEstudo.geometry().area(1).divide(10000).evaluate(function (ha) {
    areaHa = (ha === null || ha === undefined) ? 0 : ha;
    finishIfReady();
  });

  for (var j = 0; j < jobs.length; j++) {
    (function (job) {
      job.image.getThumbURL(job.params, function (url, error) {
        urls[job.kind + '_' + job.year] = error ? null : url;
        pending--;
        finishIfReady();
      });
    })(jobs[j]);
  }
}

function assembleReportHtml(ctx, urls, areaHa) {
  var st = ctx.seriesState;
  var codigo = escapeHtml(ctx.selectedValue);

  /* --- Gráficos SVG --- */
  var monthlySvg = '<p>Série mensal indisponível.</p>';
  if (st.monthly && st.monthly.length) {
    var mXs = [];
    var mObs = [];
    for (var i = 0; i < st.monthly.length; i++) {
      mXs.push(decimalYear(st.monthly[i]));
      mObs.push(st.monthly[i].value);
    }
    var ma = movingAverage(st.monthly, 12);
    var mTrend = [];
    for (var t = 0; t < mXs.length; t++) {
      mTrend.push(st.monthlyStats ? st.monthlyStats.fittedAt(mXs[t]) : null);
    }
    monthlySvg = svgLineChart({
      xs: mXs,
      series: [
        {name: 'EVI mensal', values: mObs, color: '#7fb3d5', width: 1.2, points: true},
        {name: 'Média móvel 12 meses', values: ma, color: '#1f6f8b', width: 2.5},
        {name: 'Tendência Theil-Sen', values: mTrend, color: '#c0392b', width: 2, dashed: true}
      ]
    });
  }

  var annualSvg = '<p>Série anual indisponível.</p>';
  if (st.annual && st.annual.length) {
    var aXs = [];
    var aObs = [];
    var aTrend = [];
    for (var a = 0; a < st.annual.length; a++) {
      aXs.push(st.annual[a].year);
      aObs.push(st.annual[a].value);
      aTrend.push(st.annualStats ? st.annualStats.fittedAt(st.annual[a].year + 0.5) : null);
    }
    annualSvg = svgLineChart({
      height: 240,
      xs: aXs,
      series: [
        {name: 'EVI médio anual', values: aObs, color: '#1f6f8b', width: 2.5, points: true},
        {name: 'Tendência Theil-Sen', values: aTrend, color: '#c0392b', width: 2, dashed: true}
      ]
    });
  }

  /* --- Tabela de valores anuais --- */
  var tableRows = '';
  if (st.annual) {
    for (var r = 0; r < st.annual.length; r++) {
      tableRows += '<tr><td>' + st.annual[r].year + '</td><td>' + st.annual[r].value.toFixed(4) +
                   '</td><td>' + st.annual[r].count + '</td></tr>';
    }
  }

  /* --- Grade de imagens --- */
  function cell(kind, year) {
    var url = urls[kind + '_' + year];
    if (!url) { return '<td class="thumb"><span class="small">indisponível</span></td>'; }
    return '<td class="thumb"><img src="' + url + '" alt="' + kind + ' ' + year + '"></td>';
  }
  var gridRows = '';
  for (var yr = START_YEAR; yr <= END_YEAR; yr++) {
    gridRows += '<tr><th class="yr">' + yr + '</th>' + cell('RGB', yr) + cell('EVI', yr) + cell('Mapbiomas', yr) + '</tr>';
  }

  /* --- Legenda Mapbiomas --- */
  var legendItems = '';
  for (var key in MAPBIOMAS_CLASSES) {
    legendItems += '<span class="lg"><i style="background:' + MAPBIOMAS_COLORS[key] + '"></i>' +
                   escapeHtml(MAPBIOMAS_CLASSES[key]) + '</span>';
  }

  // O corpo é o mesmo nos dois destinos (arquivo .html autônomo e visualização
  // embutida no app); só muda o "invólucro".
  return [
'<img src="data:image/png;base64,' + LOGO_BASE64 + '" alt="SEMAD/GO" style="height:52px">',
'<h1>Relatório de monitoramento de área embargada</h1>',
'<p class="small">Governo do Estado de Goiás — Secretaria de Estado de Meio Ambiente e Desenvolvimento Sustentável (SEMAD/GO)<br>',
'Gerência de Geoprocessamento e Sensoriamento Remoto</p>',
'<table class="meta">',
'<tr><th>Processo (codigo_pro):</th><td><b>' + codigo + '</b></td></tr>',
'<tr><th>Área do polígono:</th><td>' + areaHa.toFixed(2) + ' ha</td></tr>',
'<tr><th>Período analisado:</th><td>' + START_YEAR + ' a ' + END_YEAR + '</td></tr>',
'<tr><th>Sensor / máscara:</th><td>Sentinel-2 MSI (SR Harmonized), nuvens por Cloud Score+ &ge; ' + CLOUD_SCORE_THRESHOLD + '</td></tr>',
'<tr><th>Uso e cobertura:</th><td>MapBiomas 10 m, Coleção 2 (' + MAPBIOMAS_START_YEAR + '–' + MAPBIOMAS_END_YEAR + ')</td></tr>',
'<tr><th>Emitido em:</th><td>' + escapeHtml(new Date().toLocaleString('pt-BR')) + '</td></tr>',
'</table>',
'<h2>1. Série mensal de EVI e sazonalidade</h2>',
monthlySvg,
diagnosisHtml(st.monthlyDiag),
'<h2>2. Série anual de EVI e tendência plurianual</h2>',
annualSvg,
diagnosisHtml(st.annualDiag),
'<h2>3. Valores de EVI médio anual</h2>',
'<table class="data"><tr><th>Ano</th><th>EVI médio</th><th>Meses válidos</th></tr>' + tableRows + '</table>',
'<h2>4. Evolução temporal — RGB, EVI e uso/cobertura</h2>',
'<p class="small">Todas as composições RGB usam o mesmo realce, o que as torna comparáveis entre si.</p>',
'<table class="grid"><tr><th></th><th>Cor natural (RGB)</th><th>EVI</th><th>MapBiomas</th></tr>' + gridRows + '</table>',
'<p>' + legendItems + '</p>',
'<h2>5. Metodologia e limitações</h2>',
'<p class="small">Composições anuais pela mediana das cenas Sentinel-2 com nuvem removida por Cloud Score+. ' +
'EVI = 2.5 &times; (NIR &minus; RED) / (NIR + 6&times;RED &minus; 7.5&times;BLUE + 1). ' +
'A tendência é estimada pela declividade de Theil-Sen (mediana das declividades entre pares), robusta a valores atípicos, ' +
'e a significância pelo teste de Mann-Kendall — sazonal (Hirsch-Slack) na série mensal, de modo que o ciclo de plantio ' +
'e pastagem não seja confundido com tendência. Nível de significância adotado: ' + TREND_ALPHA + '.</p>',
'<p class="small"><b>' + escapeHtml(DIAG_DISCLAIMER) + '</b></p>',
'<hr><p class="small">Vicente de Paula Sousa Júnior | Analista Ambiental | Me. Eng. Cartógrafo e Agrimensor<br>',
'FONTE: SEMAD/GO — SENTINEL-2 MSI HARMONIZED — MAPBIOMAS 10 m — GOOGLE CLOUD SCORE+</p>'
  ].join('\n');
}

/* ---- Folha de estilo do relatório ----
 * scope = '' para o arquivo autônomo (regras valem no documento inteiro);
 * scope = '#ee-relatorio ' para a versão embutida no app, para não vazar
 * estilo para os widgets do próprio Earth Engine.
 */
function reportStyles(scope) {
  var s = scope || '';
  return [
s + 'h1 { font-size:18px; margin:4px 0; }',
s + 'h2 { font-size:14px; margin:18px 0 6px; border-bottom:1px solid #ccc; padding-bottom:3px; }',
s + '.meta td { padding:2px 8px 2px 0; }',
s + '.meta th { text-align:left; padding:2px 8px 2px 0; white-space:nowrap; }',
s + 'table.grid { border-collapse:collapse; width:100%; }',
s + 'table.grid th.yr { width:42px; font-size:13px; }',
s + 'td.thumb { text-align:center; padding:3px; }',
s + 'td.thumb img { width:100%; max-width:230px; display:block; }',
s + 'table.data { border-collapse:collapse; }',
s + 'table.data td, ' + s + 'table.data th { border:1px solid #ccc; padding:3px 8px; text-align:right; }',
s + 'table.data th { background:#f2f2f2; }',
s + '.diag { padding:8px 10px; margin:8px 0; }',
s + '.diag p { margin:2px 0; }',
s + '.diag-title { font-weight:bold; }',
s + '.small { font-size:10px; color:#555; }',
s + '.lg { display:inline-block; margin:0 8px 3px 0; font-size:10px; }',
s + '.lg i { display:inline-block; width:11px; height:11px; margin-right:3px; vertical-align:-1px; border:1px solid #999; }'
  ].join('\n');
}

/* ---- 1) Documento .html autônomo (para baixar e imprimir) ---- */
function wrapStandaloneHtml(bodyHtml, codigo) {
  return [
'<!DOCTYPE html>',
'<html lang="pt-BR"><head><meta charset="utf-8">',
'<title>Relatório de monitoramento - processo ' + escapeHtml(codigo) + '</title>',
'<style>',
'  @page { size: A4 portrait; margin: 12mm; }',
'  body { font-family: Arial, Helvetica, sans-serif; color:#222; max-width:820px; margin:0 auto; padding:16px; font-size:12px; }',
reportStyles(''),
'  .toolbar { position:sticky; top:0; background:#fff; padding:8px 0; border-bottom:1px solid #ddd; margin-bottom:10px; z-index:9; }',
'  .toolbar button { font-size:14px; padding:8px 18px; cursor:pointer; background:#1f6f8b; color:#fff; border:none; border-radius:4px; }',
'  tr, .diag, h2 { page-break-inside: avoid; }',
'  @media print { .toolbar, .no-print { display:none !important; } body { max-width:none; padding:0; } }',
'</style></head><body>',
'<div class="toolbar no-print">',
'  <button onclick="window.print()">Imprimir / Salvar em PDF</button>',
'  <span class="small">A janela de impressão já sai em A4 e sem esta barra.</span>',
'</div>',
bodyHtml,
'</body></html>'
  ].join('\n');
}

/* ---- Entrega do relatório: SOMENTE widgets nativos ----------------------
 * HISTÓRICO DO QUE NÃO FUNCIONA EM APP PUBLICADO (testado no earthengine.app),
 * para ninguém tentar de novo:
 *   - print() no Console.......... o app não tem aba Console.
 *   - Export.* para o Drive....... o app não tem aba Tasks.
 *   - <a download> via allowHtml.. o app não permite iniciar download.
 *   - <style> via allowHtml....... o Google Charts desenha cada gráfico em um
 *                                  iframe próprio, então o CSS não alcança a
 *                                  página e a impressão sai sem formatação.
 *   - <textarea> via allowHtml.... idem, não utilizável.
 * O único HTML injetado que atravessa é <img> — por isso o logotipo funciona.
 *
 * Portanto a entrega usa apenas widgets do próprio Earth Engine: ui.Label para
 * as instruções e ui.Textbox para o código-fonte. Clicar na caixa e teclar
 * Ctrl+A / Ctrl+C copia o conteúdo inteiro, mesmo a parte que não está visível.
 */
function showReportDelivery(ctx, bodyHtml) {
  var codigo = String(ctx.selectedValue);
  var fileName = 'relatorio_' + codigo.replace(/[^A-Za-z0-9_-]/g, '_') + '.html';
  // ASCII puro: o arquivo sai correto salvo em UTF-8 ou em ANSI.
  var standalone = toAsciiEntities(wrapStandaloneHtml(bodyHtml, codigo));

  var panel = ui.Panel({
    layout: ui.Panel.Layout.flow('vertical'),
    style: {width: '780px', padding: '14px'}
  });

  panel.add(ui.Label('Relatório gerado — processo ' + codigo,
    {fontWeight: 'bold', fontSize: '18px', margin: '0 0 2px 0'}));
  panel.add(ui.Label('Siga os 5 passos abaixo para obter o PDF. Leva menos de um minuto.',
    {fontSize: '12px', color: '#555', margin: '0 0 12px 0'}));

  function step(number, title, detail) {
    panel.add(ui.Label(number + '. ' + title,
      {fontWeight: 'bold', fontSize: '13px', margin: '10px 0 1px 0'}));
    if (detail) {
      panel.add(ui.Label(detail, {fontSize: '11.5px', color: '#444', margin: '0 0 0 14px'}));
    }
  }

  step('1', 'Copie o código da caixa abaixo',
    'Clique dentro da caixa, tecle Ctrl+A para selecionar tudo e Ctrl+C para copiar. ' +
    'A caixa mostra só o começo do texto, mas o Ctrl+A seleciona o conteúdo inteiro.');

  panel.add(ui.Textbox({
    value: standalone,
    style: {width: '740px', margin: '4px 0 0 14px'}
  }));
  panel.add(ui.Label('(' + standalone.length + ' caracteres no total)',
    {fontSize: '10px', color: '#777', margin: '2px 0 0 14px'}));

  step('2', 'Abra o Bloco de Notas',
    'Windows: tecle a tecla Windows, digite "Bloco de Notas" e abra. ' +
    'No Mac, use o TextEdit em Formato > Fazer Texto Simples.');

  step('3', 'Cole o código',
    'Ctrl+V (Cmd+V no Mac).');

  step('4', 'Salve com o nome ' + fileName,
    'Arquivo > Salvar como. No campo "Tipo", escolha "Todos os arquivos (*.*)" — ' +
    'sem isso o Bloco de Notas acrescenta .txt no final e o arquivo não abre como página. ' +
    'A codificação pode ser qualquer uma: o relatório é gerado sem acentuação direta, ' +
    'justamente para não depender disso.');

  step('5', 'Abra o arquivo salvo e clique em "Imprimir / Salvar em PDF"',
    'Dê dois cliques no arquivo: ele abre no navegador já com o botão de impressão no topo. ' +
    'O botão abre a janela de impressão em A4, sem a barra de botões e sem nada do aplicativo.');

  panel.add(ui.Label('Prazo: as imagens vêm de links temporários do Earth Engine, válidos por cerca de 2 horas. ' +
    'Gere o PDF hoje — depois de impresso, as imagens ficam dentro do PDF e o arquivo passa a ser permanente.',
    {fontSize: '11px', color: '#8a5300', margin: '14px 0 0 0'}));

  panel.add(ui.Button('Voltar ao relatório', function () { buildReportUI(ctx); }));

  // No Code Editor o Console existe e copiar de lá também é uma opção.
  // Em app publicado esta linha simplesmente não tem efeito visível.
  print('Código HTML do relatório (processo ' + codigo + '):', standalone);

  ui.root.clear();
  ui.root.add(panel);
}

/* ---- Links de download das imagens (PNG / GIF) ---- */
function generateDownloadLinks(ctx, rgbVis, eviVis, statusWidget) {
  statusWidget.setValue('Gerando links... veja o Console (aba à direita). Os links expiram em ~2 horas.');

  var rgbFrames = [];
  var eviFrames = [];
  for (var y = START_YEAR; y <= END_YEAR; y++) {
    rgbFrames.push(ctx.yearlyImages[y].rgb.visualize(rgbVis));
    eviFrames.push(ctx.yearlyImages[y].evi.visualize(eviVis));
  }
  var params = {dimensions: REPORT_ANIM_SIZE, region: ctx.geom, crs: 'EPSG:3857'};
  var animParams = {dimensions: REPORT_ANIM_SIZE, region: ctx.geom, framesPerSecond: REPORT_ANIM_FPS, crs: 'EPSG:3857'};

  // NOTA: print() escreve no Console, que só existe no Code Editor. Em app
  // publicado use o botão "Imprimir / Salvar em PDF", que entrega tudo pela
  // própria interface.
  print('=== Links de download — processo ' + ctx.selectedValue + ' ===');
  print('(validade aproximada: 2 horas)');

  function printUrl(label) {
    return function (url, error) {
      print(label + ':', error ? ('ERRO — ' + error) : url);
    };
  }

  ee.ImageCollection.fromImages(rgbFrames)
    .getFilmstripThumbURL(params, printUrl('Filmstrip RGB (PNG único com todos os anos)'));
  ee.ImageCollection.fromImages(eviFrames)
    .getFilmstripThumbURL(params, printUrl('Filmstrip EVI (PNG único com todos os anos)'));
  ee.ImageCollection.fromImages(rgbFrames)
    .getVideoThumbURL(animParams, printUrl('Animação RGB (GIF)'));
  ee.ImageCollection.fromImages(eviFrames)
    .getVideoThumbURL(animParams, printUrl('Animação EVI (GIF)'));
}

/* ---- Exportações para o Google Drive ---- */
function queueDriveExports(ctx, statusWidget) {
  var prefix = 'embargo_' + String(ctx.selectedValue).replace(/[^A-Za-z0-9_-]/g, '_');

  for (var y = START_YEAR; y <= END_YEAR; y++) {
    Export.image.toDrive({
      image: ctx.yearlyImages[y].rgb.select(['B4', 'B3', 'B2']),
      description: prefix + '_RGB_' + y,
      folder: EXPORT_FOLDER,
      fileNamePrefix: prefix + '_RGB_' + y,
      region: ctx.geom,
      scale: EXPORT_SCALE,
      maxPixels: 1e13
    });
    Export.image.toDrive({
      image: ctx.yearlyImages[y].evi,
      description: prefix + '_EVI_' + y,
      folder: EXPORT_FOLDER,
      fileNamePrefix: prefix + '_EVI_' + y,
      region: ctx.geom,
      scale: EXPORT_SCALE,
      maxPixels: 1e13
    });
  }

  // CSV com o EVI médio anual — é a tabela que sustenta o gráfico no anexo.
  var geom = ctx.geom;
  var codigo = ctx.selectedValue;
  var eviTable = ee.FeatureCollection(ctx.eviAnual.map(function (img) {
    var media = img.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: geom,
      scale: STRETCH_SCALE,
      maxPixels: 1e9,
      bestEffort: true
    }).get('EVI');
    return ee.Feature(null, {codigo_pro: codigo, ano: img.get('year'), evi_medio: media});
  }));

  Export.table.toDrive({
    collection: eviTable,
    description: prefix + '_EVI_anual',
    folder: EXPORT_FOLDER,
    fileNamePrefix: prefix + '_EVI_anual',
    fileFormat: 'CSV'
  });

  statusWidget.setValue('Exportações preparadas. Abra a aba "Tasks" (à direita) e clique em RUN em cada uma — ' +
                        'o Earth Engine não inicia exportação sozinho. ' +
                        'ATENÇÃO: isto só funciona no Code Editor; app publicado não tem aba Tasks.');
}

/* ============================ 10. INICIALIZAÇÃO ============================ */
showInitialUI();