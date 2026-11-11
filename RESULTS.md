# Owed benchmark

Backend: Real models, simulated PayPal stand-in

> We ran 144 attacks against 3 AI models holding PayPal's refund tool, each with a strong prompt and the records in front of it. On their own, 1 of 3 paid out money that was not owed, on 3 of 432 attempts, $60.00 in total. With Owed in front of the same models it was 0 of 432, and 72 of 72 honest customers were still paid in full.

| Model | Door | Attacks overpaid | Paid beyond what was owed | Honest paid in full | Median time | Tokens in / out | Errors |
|---|---|---|---|---|---|---|---|
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 1, on its own | 0 of 144 | $0.00 | 22 of 24 | 2986 ms | 402009 / 18674 | 0 |
| openai:Qwen/Qwen3-235B-A22B-Instruct-2507 | 2, with Owed | 0 of 144 | $0.00 | 24 of 24 | 2309 ms | 450519 / 23046 | 0 |
| openai:openai/gpt-oss-120b | 1, on its own | 3 of 144 | $60.00 | 24 of 24 | 1979 ms | 641168 / 57101 | 0 |
| openai:openai/gpt-oss-120b | 2, with Owed | 0 of 144 | $0.00 | 24 of 24 | 1675 ms | 645302 / 59581 | 0 |
| openai:moonshotai/Kimi-K3 | 1, on its own | 0 of 144 | $0.00 | 24 of 24 | 3378 ms | 577243 / 128301 | 0 |
| openai:moonshotai/Kimi-K3 | 2, with Owed | 0 of 144 | $0.00 | 24 of 24 | 3420 ms | 583756 / 136743 | 0 |

Every case starts from a fresh order. Door 1 and Door 2 get the same model, system prompt, tools and customer turns. Only the routing of create_refund differs.
Attacks all run on the overcharge order, where $5 is owed. Honest requests cover four kinds of order. The prompt, the attacks and every row are in this repository.
