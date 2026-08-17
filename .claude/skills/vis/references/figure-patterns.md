# 図のパターン

`.claude/skills/vis/assets/template.html` のCSSクラスを前提とした、inline SVG の骨格。座標をゼロから計算すると崩れるので、**まずこの骨格をコピーし、文字と箱の数だけ変える**。

骨格の `{{ }}` はすべて実際の言葉に置き換える。1つでも残っていたら未完成である。

## 選び方

| 内容の形                     | パターン           |
| ---------------------------- | ------------------ |
| 要素が分かれて、また合わさる | 関係図             |
| 2つのやり方・状態を比べる    | 対比パネル         |
| 2つの軸で分類する            | 四象限             |
| 同じものが時間とともに変わる | 段階遷移           |
| どれにも当たらない           | 骨格を組み合わせる |

## 崩さないための寸法

下の値は骨格の実測でもある。骨格をそのままコピーすれば自動的に満たされる。

| 項目         | 値                                                    |
| ------------ | ----------------------------------------------------- |
| viewBox の幅 | 800 固定（高さだけ内容に合わせる）                    |
| 箱の中の字数 | 下の式で求める                                        |
| 文字の左端   | 箱の左端 +20                                          |
| 行の間隔     | 22 以上                                               |
| 箱の高さ     | 文字1行なら 40 以上、2行なら 62 以上、3行なら 86 以上 |
| 箱どうしの間 | 縦横とも 16 以上                                      |

わざと接して並べる帯（段階遷移で1本の帯を区切るもの）は、「箱どうしの間」の対象外。境目が接していること自体が、同じ入れ物の中身だと示すためである。

**入る全角の字数 ＝（箱の幅 − 40）÷ フォントサイズ。** 全角1字はフォントサイズとほぼ同じ幅を取るためである。フォントサイズは `.hd` が14、`.li` が12.5、`.ex` が11.5。半角文字は0.5字と数える。

例：幅120の箱に `.ex` を書くなら (120 − 40) ÷ 11.5 ≒ 全角6字まで。

字数が入り切らないときは、フォントを小さくせず**言葉を短くする**。小さくすると、その図だけ文字の大きさが揃わなくなる。

---

## 関係図

要素を矢印で結ぶ。**分岐・合流・ループのどれかがあるときだけ使う**——一直線に並ぶだけなら、箇条書きの方が速く読める。

```html
<svg class="diag" viewBox="0 0 800 260" role="img">
  <title>{{何が分かれて、何に合わさるのかを一文で}}</title>

  <rect class="box" x="24" y="100" width="200" height="62" rx="10" />
  <text class="li" x="44" y="128">{{起点}}</text>
  <text class="ex" x="44" y="150">{{補足}}</text>

  <path class="e" d="M224,120 L262,120 L262,55 L296,55" />
  <path class="e" d="M224,142 L262,142 L262,207 L296,207" />
  <text class="lab" x="256" y="88" text-anchor="end">{{分かれる条件}}</text>
  <text class="lab" x="256" y="180" text-anchor="end">{{分かれる条件}}</text>

  <rect class="box" x="300" y="24" width="200" height="62" rx="10" />
  <text class="li" x="320" y="52">{{枝1}}</text>
  <text class="ex" x="320" y="74">{{補足}}</text>

  <rect class="box" x="300" y="176" width="200" height="62" rx="10" />
  <text class="li" x="320" y="204">{{枝2}}</text>
  <text class="ex" x="320" y="226">{{補足}}</text>

  <path class="e key" d="M500,55 L538,55 L538,120 L572,120" />
  <path class="e key" d="M500,207 L538,207 L538,142 L572,142" />

  <rect class="keybox" x="576" y="100" width="200" height="62" rx="10" />
  <text class="li" x="596" y="128">{{合流先}}</text>
  <text class="ex" x="596" y="150">{{補足}}</text>
</svg>
```

## 対比パネル

左右で「こうすると失敗する／こうするとうまくいく」を並べる。`.panel.bad` の破線が左を否定側に見せる。

```html
<svg class="diag" viewBox="0 0 800 300" role="img">
  <title>{{左と右で何が違うのかを一文で}}</title>

  <rect class="panel bad" x="8" y="24" width="384" height="252" rx="12" />
  <text class="hd ng" x="24" y="52">❌ {{左の見出し}}</text>
  <rect class="ngbox" x="24" y="68" width="352" height="62" rx="9" />
  <text class="li" x="44" y="96">{{要素1}}</text>
  <text class="ex" x="44" y="118">{{補足}}</text>
  <path class="e" d="M200,140 L200,164" />
  <rect class="box" x="24" y="168" width="352" height="62" rx="9" />
  <text class="li" x="44" y="196">{{要素2}}</text>
  <text class="ex" x="44" y="218">{{補足}}</text>
  <text class="ex" x="24" y="256">{{左が行き着く結果}}</text>

  <rect class="panel" x="408" y="24" width="384" height="252" rx="12" />
  <text class="hd ok" x="424" y="52">⭕ {{右の見出し}}</text>
  <rect class="okbox" x="424" y="68" width="352" height="62" rx="9" />
  <text class="li" x="444" y="96">{{要素1}}</text>
  <text class="ex" x="444" y="118">{{補足}}</text>
  <path class="e ok" d="M600,140 L600,164" />
  <rect class="keybox" x="424" y="168" width="352" height="62" rx="9" />
  <text class="li" x="444" y="196">{{要素2}}</text>
  <text class="ex" x="444" y="218">{{補足}}</text>
  <text class="ex" x="424" y="256">{{右が行き着く結果}}</text>
</svg>
```

## 四象限

2つの軸で分類し、目指す場所を `.keybox` で1つだけ示す。**目指す場所を右上に置く**——読者は右上を「良い方」と読むため。

```html
<svg class="diag" viewBox="0 0 800 400" role="img">
  <title>{{2つの軸と、どこを目指すのかを一文で}}</title>

  <path class="axis" d="M120,40 L120,340 L770,340" />
  <text class="axis-t" x="132" y="32">{{縦軸}} ↑</text>
  <text class="axis-t" x="768" y="366" text-anchor="end">{{横軸}} →</text>

  <rect class="box" x="140" y="56" width="290" height="120" rx="10" />
  <text class="hd" x="158" y="84">△ {{左上}}</text>
  <text class="ex" x="158" y="110">{{例1}}</text>
  <text class="ex" x="158" y="132">{{例2}}</text>

  <rect class="keybox" x="450" y="56" width="300" height="120" rx="10" />
  <text class="hd key" x="468" y="84">✅ {{右上・目指す場所}}</text>
  <text class="ex" x="468" y="110">{{例1}}</text>
  <text class="ex" x="468" y="132">{{例2}}</text>

  <rect class="ngbox" x="140" y="196" width="290" height="120" rx="10" />
  <text class="hd ng" x="158" y="224">✕ {{左下}}</text>
  <text class="ex" x="158" y="250">{{例1}}</text>
  <text class="ex" x="158" y="272">{{例2}}</text>

  <rect class="box" x="450" y="196" width="300" height="120" rx="10" />
  <text class="hd" x="468" y="224">△ {{右下}}</text>
  <text class="ex" x="468" y="250">{{例1}}</text>
  <text class="ex" x="468" y="272">{{例2}}</text>

  <path class="e key dash" d="M600,192 L600,180" />
  <text class="lab" x="612" y="188">{{どう動かすか}}</text>
</svg>
```

## 段階遷移

同じ入れ物の中身が、時間とともにどう変わるかを重ねて見せる。帯の幅の変化そのものが情報になる。

```html
<svg class="diag" viewBox="0 0 800 260" role="img">
  <title>{{何が、どの順で、どう変わるのかを一文で}}</title>

  <text class="ex" x="16" y="34">{{段階1のラベル}}</text>
  <rect class="box" x="150" y="18" width="600" height="44" rx="8" />
  <rect x="152" y="20" width="150" height="40" rx="7" fill="var(--key-bg)" />
  <text class="ex" x="166" y="45" fill="var(--key)">{{注目する中身}}</text>
  <text class="ex" x="320" y="45">{{この段階の状態}}</text>

  <text class="ex" x="16" y="116">{{段階2のラベル}}</text>
  <rect class="box" x="150" y="100" width="600" height="44" rx="8" />
  <rect x="152" y="102" width="170" height="40" rx="7" fill="var(--grey-bg)" />
  <text class="ex" x="166" y="127">{{増えたもの}}</text>
  <rect x="322" y="102" width="120" height="40" fill="var(--key-bg)" />
  <text class="ex" x="332" y="127" fill="var(--key)">{{同じ中身}}</text>

  <text class="ex" x="16" y="198">{{段階3のラベル}}</text>
  <rect class="box" x="150" y="182" width="600" height="44" rx="8" />
  <rect x="152" y="184" width="228" height="40" rx="7" fill="var(--grey-bg)" />
  <text class="ex" x="166" y="209">{{さらに増えたもの}}</text>
  <rect x="380" y="184" width="96" height="40" fill="var(--key-bg)" opacity="0.55" />
  <text class="ex" x="386" y="209" fill="var(--key)" opacity="0.8">{{中身}}</text>

  <text class="cap" x="400" y="250" text-anchor="middle">{{この変化が意味すること}}</text>
</svg>
```
