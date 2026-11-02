# vimics/segmentation: vimics.vet/segmentation, Claude ve ekip kuralları

Bu repo **https://vimics.vet/segmentation/** adresinde yayınlanır (GitHub Pages, `main` / kök). `main`'e giren her commit birkaç dakika içinde canlıya çıkar.
Ortak çalışanlar: Onur Demirak (`vimics` hesabı, repo sahibi) ve Umut Tutal (`umuttutal`). İkisi de `main`'e doğrudan push eder. Bu yüzden aşağıdaki kurallar conflict'i ve kaybı önlemek için zorunludur.

> Repo public. `.claude/` ve `.github/` gibi noktayla başlayan klasörler ve `_` ile başlayan klasörler sitede yayınlanmaz, ama GitHub'da herkes okuyabilir. Fiyat, maliyet, müşteri/hasta verisi, iş birliği ya da iç not koyma. **Gerçek hasta CT/DICOM verisi bu repoya asla girmez** (test için anonimleştirilmiş, izinli veri bile repoya değil, harici depolamaya).

---

## 1. Git akışı (conflict önleme)

**Oturum başında, her şeyden önce:**
```zsh
git fetch origin && git status -sb      # geride misin, yerelde commit'lenmemiş iş var mı?
git pull --rebase origin main
```
Tek seferlik ayar (her iki bilgisayarda): `git config pull.rebase true` ve `git config rebase.autoStash true`.

**Çalışırken:**
1. **Küçük ve sık commit.** Bir iş bitince hemen commit + push. Push edilmemiş commit'i gün sonuna bırakma.
2. **Push öncesi her zaman:** `git pull --rebase origin main` → (derleme adımı varsa derle ve test et) → `git push origin main`.
3. **Push reddedilirse:** asla `--force` kullanma. `git pull --rebase origin main`, test, push.
4. **Aynı dosyada uzun iş yapmadan önce haber ver.** Yarım saatten uzun sürecek bir değişiklik yapacaksan önce diğer kişiye yaz.
5. **Birkaç günlük ya da yarım kalabilecek işler dalda yapılır:** `git switch -c umut/<konu>` ya da `onur/<konu>`. Dal `git rebase origin/main` ile güncel tutulur, bitince `main`'e birleştirilip silinir. Yarım iş `main`'e girmez, çünkü `main` canlıdır.
6. **Üretilen dosyalar** (ileride bir build adımı eklenirse çıktıları): conflict'i elle çözme. Kaynağı çöz, yeniden üret, öyle commit'le. Build adımı eklendiğinde komutu ve üretilen dosya listesini bu dosyaya yaz.

**Yasaklar:**
- `main`'e `git push --force` / `--force-with-lease`: yasak.
- Push edilmiş commit'i değiştirmek (`commit --amend`, `rebase -i`, `reset --hard` + push): yasak.
- Başkasının dalını izinsiz rebase etmek ya da silmek: yasak.
- Repo ayarları, Pages ayarı, `main`'i silmek: yalnız Onur.
- Bu repoya `CNAME` dosyası **eklenmez**. Adresi `vimics.github.io` reposunun `vimics.vet` domaini sağlıyor; CNAME eklemek yayını bozar.

## 2. Claude oturumları için

- Oturum başında §1'deki `fetch` + `status` komutlarını çalıştır ve sonucu kullanıcıya bildir.
- **`git push` yalnız oturumu kullanan kişi açıkça "push et" dediğinde yapılır.** Commit serbest, push değil.
- Push'tan sonra Pages derlemesini bekle ve canlı adresi kontrol et:
  ```zsh
  gh api repos/vimics/segmentation/pages/builds/latest --jq '.status+" "+.commit[0:7]'   # "built <commit>"
  curl -s -o /dev/null -w '%{http_code}\n' https://vimics.vet/segmentation/
  ```
- Force push, history yeniden yazma, dal silme, repo/Pages ayarı değiştirme: kullanıcı açıkça istese bile önce ne kaybolacağını söyle ve teyit al.
- Kullanıcıyla Türkçe konuş; sayfa metni İngilizce.
- Commit mesajı: İngilizce, emir kipi, tek satır özet.

## 3. Yollar ve ana siteyle ilişki

- Sayfa `https://vimics.vet/segmentation/` altında çalışır. Repo içi bağlantılar **göreli** (`./app.js`) ya da `/segmentation/...` önekli olmalı; `/app.js` ana sitenin köküne gider.
- Ana sitenin stilleri mutlak yolla kullanılabilir: `/assets/site.css`, `/assets/fonts/`, `/favicon.ico` (kaynağı: `vimics/vimics.github.io`). O dosyalar ana sitede değişirse bu sayfa da etkilenir.
- Ana site reposunda `segmentation/` adlı klasör açılmaz (yol çakışır).
- Tasarım: Vimics Design System, https://claude.ai/artifact/8A46AUCeVLFiiFQ87dr2FU.
- İçerik kuralları ana siteyle aynı: CE/FDA onaylı, "en iyi / lider / tek / ilk", sonuç garantisi, ünlem, emoji, fiyat, teslim süresi, telefon yok.
- Sayfa hazır olana kadar `index.html`'de `<meta name="robots" content="noindex">` kalır; yayına hazır olunca Onur'la birlikte kaldırılır ve ana sitenin `sitemap.xml`'ine eklenir.
