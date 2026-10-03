package dev.nearkeylite
class FrameCodec { private val out=java.io.ByteArrayOutputStream();private var seq=0;private var start=0L
 fun clear(){out.reset();seq=0;start=0}
 fun feed(f:ByteArray):String?{require(f.size in 4..20);val flags=f[0].toInt();if(flags and 1!=0){clear();start=System.currentTimeMillis()};val s=((f[1].toInt() and 255) shl 8) or (f[2].toInt() and 255);require(start>0&&System.currentTimeMillis()-start<15000&&s==seq++);out.write(f,3,f.size-3);require(out.size()<=4096);if(flags and 2==0)return null;val r=out.toString("UTF-8");clear();return r}
 companion object { fun split(s:String):List<ByteArray>{val b=s.toByteArray();require(b.size in 1..4096);return b.indices.step(17).mapIndexed{i,p->val e=minOf(p+17,b.size);byteArrayOf(((if(p==0)1 else 0) or (if(e==b.size)2 else 0)).toByte(),(i shr 8).toByte(),i.toByte())+b.copyOfRange(p,e)}} }
}
