const e=require("express")();e.get("/",(_,r)=>r.json({ok:1}));e.listen(process.env.PORT||3000)
