`timescale 1ns/1ps
module tb_result_formatter;
reg clk=0,reset_n=0,enable=1,valid=0,ready=0,alarm=0;
reg [1:0] sid=0; reg [15:0] idx=0; reg [54:0] energy=0;
always #5 clk=~clk;
wire [7:0] data; wire tv,overflow;
reg [7:0] expected[0:2047];
reg [111:0] packet; reg [7:0] sum;
integer sent=0,seen=0,i,j; reg check=1;
result_formatter dut(clk,reset_n,enable,1'b0,1'b0,2'd0,16'd0,16'sd0,
 valid,sid,idx,energy,alarm,data,tv,ready,overflow);
always @(posedge clk) if(tv && ready && check) begin
 if(seen>=sent || data!==expected[seen]) $fatal(1,"FAIL FIFO output %d",seen);
 seen=seen+1;
end
task push;
 input [54:0] e; input [1:0] s;
 begin
  @(negedge clk); energy=e; sid=s; idx=599; alarm=s[0]; valid=1;
  if(check) begin
   packet={8'd0,7'd0,s[0],9'd0,e,16'd599,6'd0,s,8'h55}; sum=0;
   for(j=0;j<13;j=j+1) sum=sum+packet[j*8 +: 8];
   packet[111:104]=sum;
   for(j=0;j<14;j=j+1) begin expected[sent]=packet[j*8 +: 8]; sent=sent+1; end
  end
 end
endtask
initial begin
 repeat(3) @(negedge clk); reset_n=1;
 // Four simultaneous-window arrivals while the UART cannot accept bytes.
 push(55'h7fffffffffffff,0); push(55'd1,1); push(55'd2250000,2); push(55'd35800000,3);
 @(negedge clk); valid=0;
 repeat(10) @(negedge clk); if(overflow || !tv) $fatal(1,"FAIL FIFO stall");
 // Alternate readiness to emulate a stalled byte consumer.
 for(i=0;i<180;i=i+1) begin @(negedge clk); ready=i%2; end
 if(seen!=sent || overflow) $fatal(1,"FAIL four-result buffering");
 ready=1;
 // Exercise repeated pointer wrapping and simultaneous enqueue/dequeue.
 for(i=0;i<24;i=i+1) begin push(i*1234567,i%4); @(negedge clk); valid=0; repeat(18) @(negedge clk); end
 repeat(30) @(negedge clk);
 if(seen!=sent || overflow) $fatal(1,"FAIL FIFO wrap");
 check=0; ready=0;
 for(i=0;i<10;i=i+1) push(i,i%4);
 @(negedge clk); valid=0; repeat(3) @(negedge clk);
 if(!overflow) $fatal(1,"FAIL FIFO overflow not reported");
 enable=0; @(negedge clk); if(tv) $fatal(1,"FAIL disable flush");
 reset_n=0; @(negedge clk); reset_n=1;
 if(overflow) $fatal(1,"FAIL FIFO reset");
 $display("PASS result FIFO: four close results, stalls, 55-bit extension, wrap, overflow, flush/reset"); $finish;
end
endmodule
