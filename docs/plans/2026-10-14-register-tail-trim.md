# Pembersihan Ujung Register Nomor Surat Implementation Plan

> **For Claude:** Gunakan `skill://executing-plans`; ini mengaktifkan kembali kebutuhan kedua setelah pengguna memperjelas contoh dan menyetujui seluruh ujung kosong dibersihkan. Rencana pertama perapihan form sudah selesai dan tidak diubah.

**Status:** Kode diimplementasikan dan diverifikasi 14 Oktober 2026. Unit, typecheck, lint, PostgreSQL disposable, full writer/cron regression serta API/native UI smoke lulus; reviewer SQL dan writer/API tidak mempunyai temuan tersisa. Aktivasi produksi masih milik pengguna: jalankan migrasi 20261012 hanya jika belum diterapkan. Jangan mengulang langkah implementasi atau menjalankan migrasi/seed otomatis.

**Goal:** Menghapus cadangan kosong setelah nomor terakhir yang masih digunakan ketika surat paling maju dihapus, lalu melanjutkan penghitung dari nomor yang bertahan.

**Architecture:** Penandaan pensiun slot dalam transaksi allocator yang sama, projection Sheets tanpa slot pensiun, acknowledgement seluruh tanggal/bulan terdampak, lalu finalisasi atomik penghapusan slot dan penurunan penghitung resmi. Bukti penghapusan disimpan berdasarkan ID privat surat agar status tidak ditebak dari slot yang hilang atau nomor yang kelak digunakan ulang.

**Tech Stack:** Postgres/Supabase RPC, Next.js API, projection Google Sheets yang sudah ada. Tidak menambah dependency dan tidak menjalankan migrasi atau pengujian terhadap produksi.

## Perilaku yang disetujui

1. Surat 6226 tanggal 3 November dihapus. Nomor terakhir terpakai 6181 tanggal 2 November bertahan. Seluruh slot kosong di atas 6181 dihapus, termasuk 6182–6226 dan cadangan di atas 6226. Frontier alokasi menjadi 6181 setelah Sheets dikonfirmasi.
2. Surat 6181 kemudian dihapus. Nomor terakhir terpakai 5057 tanggal 8 Oktober bertahan. Seluruh slot kosong di atas 5057 dibersihkan, termasuk tanggal antara Oktober–November. Frontier alokasi menjadi 5057 setelah Sheets dikonfirmasi.
3. Nomor baru melanjutkan frontier yang bertahan; pemesanan tanggal maju tetap mengikuti default dan rencana tanggal khusus sehingga nomor surat pada tanggal yang dipilih juga dipengaruhi cadangan intervening days.
4. Surat di tengah rentang dengan surat terpakai yang lebih tinggi tidak memicu penghapusan gap; nomor di tengah tetap tersedia kembali pada tanggal asli setelah pengosongan Sheets.
5. Surat yang masih digunakan, baris impor terisi, suffix darurat yang bertahan, kepemilikan, serta ID privat surat tidak digeser atau diturunkan.

## Integritas dan kegagalan

- Gunakan advisory lock allocator 6002026, register_state lock, lease writer dan revision acknowledgement yang sudah ada.
- Slot pensiun tetap ditahan dalam database sampai semua revision terdampak di Sheets dikonfirmasi. Kegagalan/timeout/partial/stale acknowledgement tidak boleh melepaskan atau menggunakan ulang nomor.
- Penambahan nomor baru yang dapat berbenturan ditahan selama pembersihan ujung belum dikonfirmasi; penggunaan gap yang tidak dipensiunkan tetap mempertahankan invariants/revisions.
- Semua bulan terdampak disinkronkan otomatis. Bersihkan isi register B:M tanpa menghapus baris fisik yang dapat menggeser kolom unmanaged O:Z. Bulan yang menjadi kosong tetap memiliki marker dirty yang dapat di-acknowledge; jangan memakai range E1:E0.
- Rewind hanya penghitung nomor resmi, tidak id_counter. Batas awal impor dan nomor canonical pada dokumen yang masih ada tetap dilindungi.
- Pertahankan konfigurasi default dan rencana tanggal khusus. Tanggal/range yang telah dipangkas tidak otomatis tumbuh kembali hanya karena cron penutupan; alokasi eksplisit tanggal yang terbuka dapat merealisasikan cadangan sesuai konfigurasi. Jangan membuka ulang hari yang sudah ditutup.

## Perubahan end-to-end

- Forward migration `supabase/migrations/20261012_register_tail_trim.sql`: slot pensiun, marker tanggal, receipt penghapusan, allocator/deletion/acknowledgement/status/projection RPC dengan grants service-only dan search_path terkendali.
- Writer `src/lib/google-sheets.ts`: projection/clearing aman, sinkronisasi semua bulan dirty yang diperlukan sebelum finalisasi.
- API penghapusan: cek kemampuan migration sebelum mutasi; receipt RPC `get_document_deletion_status(p_user_id,p_document_id)` mengembalikan `releasePending` dan `trimmed`. Status fresh approval/owner/admin; NOT_FOUND pada preflight hanya menunjukkan function tersedia, bukan keberhasilan penghapusan.
- HTTP202 untuk belum dikonfirmasi; HTTP200 membedakan tail dihapus atau slot tengah dikembalikan. Jangan menganggap slot hilang otomatis berarti sukses atau pending selamanya.
- Konfirmasi/feedback Cari Surat diperbarui dalam bahasa Indonesia tanpa merombak layout atau mengubah polling/edit/auth behavior.

## Verifikasi sebelum selesai

- PostgreSQL disposable: kedua contoh November, cadangan di atas 6226, slot tengah, impor terisi, suffix, seluruh register kosong, baseline counter, private ID monotonic, partial/stale/repeated ack, concurrency dengan allocation/settings/closure, custom-date target setelah trim.
- Actual writer dengan API Sheets fixture terisolasi: clearing semua bulan, bulan kosong, failed/uncertain mutation, lease/ack order dan retry tanpa penulisan produksi.
- Actual delete route dengan identitas/transport fixture: migration missing sebelum delete, body/ownership/legacy guards, pending/trimmed/middle responses, authorization change setelah mutasi dan warning preservation.
- Native actual UI: dialog batal/konfirmasi, pending message dan refresh, success trimming, nomor yang bertahan tetap tampil, polling/scoped filtering tidak rusak.
- Jalankan unit, TypeScript, zero-warning lint serta SQL regression suite terpusat; independent review SQL/writer dan API/UI. Perbarui README setelah smoke proof.

## Aktivasi

Migrasi hanya disediakan sebagai file dan diuji pada database lokal sementara. Pengguna menjalankan migrasi yang belum diterapkan melalui SQL Editor sebelum menggunakan kode penghapusan baru. Tidak mengubah database atau Google Sheets produksi dari sesi pengerjaan ini.
